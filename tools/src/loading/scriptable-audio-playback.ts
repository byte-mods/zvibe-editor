import { Observable } from "@babylonjs/core/Misc/observable";
import { SoundState } from "@babylonjs/core/AudioV2/soundState";
import { _WebAudioEngine } from "@babylonjs/core/AudioV2/webAudio/webAudioEngine";
import { PrimaryAudioBus } from "@babylonjs/core/AudioV2/abstractAudio/audioBus";
import { AbstractSoundSource } from "@babylonjs/core/AudioV2/abstractAudio/abstractSoundSource";
import { AbstractSpatialAudio } from "@babylonjs/core/AudioV2/abstractAudio/subProperties/abstractSpatialAudio";
import { AbstractStereoAudio } from "@babylonjs/core/AudioV2/abstractAudio/subProperties/abstractStereoAudio";
import { IAudioParameterRampOptions } from "@babylonjs/core/AudioV2/audioParameter";
import { AudioEngineV2, CreateSoundAsync, CreateSoundSourceAsync, _GetAudioEngine } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import { IStaticSoundPlayOptions, StaticSound } from "@babylonjs/core/AudioV2/abstractAudio/staticSound";

import {
	ICreateScriptableAudioRuntimeOptions,
	IScriptableAudioClipSource,
	IScriptableAudioGeneratorGraph,
	IScriptableAudioRuntimeDiagnostic,
	normalizeScriptableAudioGeneratorGraph,
	SCRIPTABLE_AUDIO_GRAPH_SUFFIX,
	ScriptableAudioGeneratorRuntime,
} from "./scriptable-audio";

const workletName = "babylonjs-editor-scriptable-audio-v1";
const streamBlockFrames = 2_048;
const targetQueuedBlocks = 8;
const loadedWorklets = new WeakMap<AudioContext, Promise<void>>();

/** Runtime diagnostics shared by static and streaming generated sounds. */
export interface IScriptableAudioPlaybackState {
	streaming: boolean;
	state: "starting" | "started" | "paused" | "stopped" | "disposed";
	sampleRate: number;
	channels: number;
	durationSeconds: number;
	generatedFrames: number;
	consumedFrames: number;
	queuedBlocks: number;
	underrunCount: number;
	loop: boolean;
	playbackRate: number;
	finished: boolean;
	generationBlocks: number;
	generationCpuMilliseconds: number;
	diagnostics: IScriptableAudioRuntimeDiagnostic[];
}

/** Creation dependencies; callers provide project-safe AudioClip resolution. */
export interface ICreateScriptableAudioSoundOptions extends ICreateScriptableAudioRuntimeOptions {
	engine?: AudioEngineV2 | null;
	spatialAutoUpdate?: boolean;
}

/** Common control surface implemented by the streaming adapter and consumed by SoundNode. */
export interface IScriptableAudioStreamingSound {
	readonly isScriptableAudioStreamingSound: true;
	readonly streaming: true;
	readonly engine: AudioEngineV2;
	readonly onDisposeObservable: Observable<unknown>;
	readonly onEndedObservable: Observable<IScriptableAudioStreamingSound>;
	readonly spatial: AbstractSpatialAudio;
	readonly stereo: AbstractStereoAudio;
	readonly state: SoundState;
	readonly currentTime: number;
	readonly duration: number;
	readonly name: string;
	volume: number;
	playbackRate: number;
	loop: boolean;
	outBus: PrimaryAudioBus | null;
	_isSpatial: boolean;
	setVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void;
	play(options?: Partial<IStaticSoundPlayOptions>): void;
	pause(): void;
	resume(): void;
	stop(): void;
	seek(seconds: number): void;
	dispose(): void;
	cloneAsync(): Promise<ScriptableAudioStreamingSound>;
	getPlaybackState(): IScriptableAudioPlaybackState;
}

export type ScriptableAudioSound = StaticSound | ScriptableAudioStreamingSound;

interface IStaticPlaybackOwner {
	runtime: ScriptableAudioGeneratorRuntime;
	graph: IScriptableAudioGeneratorGraph;
	options: ICreateScriptableAudioSoundOptions;
	generationCpuMilliseconds: number;
	disposed: boolean;
}

const staticPlaybackOwners = new WeakMap<StaticSound, IStaticPlaybackOwner>();

/** Worklet source is data-only and registered once per AudioContext. */
export const SCRIPTABLE_AUDIO_WORKLET_SOURCE = `
class BabylonEditorScriptableAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, Math.min(8, options.processorOptions.channels | 0));
    this.sourceSampleRate = options.processorOptions.sourceSampleRate;
    this.queue = [];
    this.fractionalFrame = 0;
    this.playbackRate = 1;
    this.playing = false;
    this.sourceEnded = false;
    this.endedPublished = false;
    this.alive = true;
    this.underruns = 0;
    this.needPublished = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }
  handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "block") {
      this.queue.push({ channels: message.channels, offset: 0, frames: message.frames });
      this.needPublished = false;
    } else if (message.type === "playing") {
      this.playing = message.value === true;
      if (this.playing) this.publishNeed();
    } else if (message.type === "rate") {
      this.playbackRate = Math.max(0.01, Math.min(4, message.value));
    } else if (message.type === "reset") {
      this.queue = [];
      this.fractionalFrame = 0;
      this.sourceEnded = false;
      this.endedPublished = false;
      this.needPublished = false;
    } else if (message.type === "source-end") {
      this.sourceEnded = true;
    } else if (message.type === "dispose") {
      this.alive = false;
      this.queue = [];
    }
  }
  sampleAt(channel, offset) {
    let remaining = offset;
    for (const block of this.queue) {
      const available = block.frames - block.offset;
      if (remaining < available) return block.channels[Math.min(channel, block.channels.length - 1)][block.offset + remaining];
      remaining -= available;
    }
    return null;
  }
  advance(frames) {
    let remaining = frames;
    let consumed = 0;
    while (remaining > 0 && this.queue.length) {
      const block = this.queue[0];
      const available = block.frames - block.offset;
      const amount = Math.min(available, remaining);
      block.offset += amount;
      remaining -= amount;
      consumed += amount;
      if (block.offset >= block.frames) this.queue.shift();
    }
    return consumed;
  }
  publishNeed() {
    if (!this.needPublished && this.queue.length < 4 && !this.sourceEnded) {
      this.needPublished = true;
      this.port.postMessage({ type: "need", queuedBlocks: this.queue.length });
    }
  }
  process(_inputs, outputs) {
    if (!this.alive) return false;
    const output = outputs[0];
    for (const channel of output) channel.fill(0);
    if (!this.playing) return true;
    const step = this.sourceSampleRate / sampleRate * this.playbackRate;
    let consumed = 0;
    for (let frame = 0; frame < output[0].length; frame++) {
      const base = Math.floor(this.fractionalFrame);
      const amount = this.fractionalFrame - base;
      const first = this.sampleAt(0, base);
      if (first === null) {
        if (!this.sourceEnded) {
          this.underruns++;
          if (this.underruns === 1 || this.underruns % 128 === 0) this.port.postMessage({ type: "underrun", count: this.underruns });
        }
        break;
      }
      for (let channel = 0; channel < output.length; channel++) {
        const left = this.sampleAt(channel, base);
        const right = this.sampleAt(channel, base + 1);
        output[channel][frame] = left + ((right === null ? left : right) - left) * amount;
      }
      this.fractionalFrame += step;
      const whole = Math.floor(this.fractionalFrame);
      if (whole > 0) {
        consumed += this.advance(whole);
        this.fractionalFrame -= whole;
      }
    }
    if (consumed) this.port.postMessage({ type: "consumed", frames: consumed, queuedBlocks: this.queue.length });
    if (this.sourceEnded && this.queue.length === 0 && !this.endedPublished) {
      this.endedPublished = true;
      this.playing = false;
      this.port.postMessage({ type: "ended" });
    }
    this.publishNeed();
    return true;
  }
}
registerProcessor("${workletName}", BabylonEditorScriptableAudioProcessor);
`;

/** Returns whether a source path selects the version-1 generated-audio asset loader. */
export function isScriptableAudioGeneratorPath(path: string | null | undefined): boolean {
	return typeof path === "string" && path.toLowerCase().endsWith(SCRIPTABLE_AUDIO_GRAPH_SUFFIX);
}

/** Decodes one browser-supported audio payload into planar PCM owned by an AudioBuffer. */
export async function decodeScriptableAudioClip(context: BaseAudioContext, data: ArrayBuffer): Promise<IScriptableAudioClipSource> {
	const isLiveContext = typeof AudioContext !== "undefined" && context instanceof AudioContext;
	const isOfflineContext = typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext;
	if (!isLiveContext && !isOfflineContext) {
		throw new Error("Scriptable Audio clip decoding requires a Web Audio context.");
	}
	const audioBuffer = await context.decodeAudioData(data.slice(0));
	return { sampleRate: audioBuffer.sampleRate, channels: Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index)) };
}

/** Loads one project-relative AudioClip through fetch and the target Web Audio context. */
export function createScriptableAudioUrlClipLoader(context: BaseAudioContext, rootUrl: string): (path: string) => Promise<IScriptableAudioClipSource> {
	return async (path: string): Promise<IScriptableAudioClipSource> => {
		const response = await fetch(`${rootUrl}${path}`);
		if (!response.ok) {
			throw new Error(`Unable to load generated-audio AudioClip "${path}": HTTP ${response.status}.`);
		}
		return decodeScriptableAudioClip(context, await response.arrayBuffer());
	};
}

/** Registers the ring-buffer processor once and always revokes its transient Blob URL. */
async function ensureWorklet(context: AudioContext): Promise<void> {
	let promise = loadedWorklets.get(context);
	if (!promise) {
		const url = URL.createObjectURL(new Blob([SCRIPTABLE_AUDIO_WORKLET_SOURCE], { type: "text/javascript" }));
		promise = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
		loadedWorklets.set(context, promise);
	}
	return promise;
}

/** Maps Babylon's numeric state to stable editor/MCP text. */
function stateName(state: SoundState, disposed: boolean): IScriptableAudioPlaybackState["state"] {
	if (disposed) {
		return "disposed";
	}
	if (state === SoundState.Starting) {
		return "starting";
	}
	if (state === SoundState.Started) {
		return "started";
	}
	if (state === SoundState.Paused) {
		return "paused";
	}
	return "stopped";
}

/** Streaming generated sound backed by an AudioWorklet and routed through a Babylon AudioV2 source. */
export class ScriptableAudioStreamingSound implements IScriptableAudioStreamingSound {
	public readonly isScriptableAudioStreamingSound = true as const;
	public readonly streaming = true as const;
	public readonly onEndedObservable = new Observable<IScriptableAudioStreamingSound>();

	private readonly _runtime: ScriptableAudioGeneratorRuntime;
	private readonly _worklet: AudioWorkletNode;
	private readonly _source: AbstractSoundSource;
	private readonly _graph: IScriptableAudioGeneratorGraph;
	private readonly _options: ICreateScriptableAudioSoundOptions;
	private _state = SoundState.Stopped;
	private _nextFrame = 0;
	private _consumedFrames = 0;
	private _queuedBlocks = 0;
	private _underrunCount = 0;
	private _loop = false;
	private _playbackRate = 1;
	private _generationBlocks = 0;
	private _generationCpuMilliseconds = 0;
	private _sourceEndSent = false;
	private _refillQueued = false;
	private _disposed = false;

	private constructor(
		name: string,
		runtime: ScriptableAudioGeneratorRuntime,
		worklet: AudioWorkletNode,
		source: AbstractSoundSource,
		options: ICreateScriptableAudioSoundOptions
	) {
		this.name = name;
		this._runtime = runtime;
		this._graph = runtime.graph;
		this._worklet = worklet;
		this._source = source;
		this._options = options;
		this._worklet.port.onmessage = (event) => this._handleWorkletMessage(event.data);
		this._source.onDisposeObservable.addOnce(() => this._cleanup());
	}

	/** Creates the native worklet and Babylon routing node only after all clips and custom nodes are ready. */
	public static async CreateAsync(name: string, graph: unknown, options: ICreateScriptableAudioSoundOptions): Promise<ScriptableAudioStreamingSound> {
		const engine = _GetAudioEngine(options.engine ?? null) as _WebAudioEngine;
		const context = engine._audioContext;
		if (!(context instanceof AudioContext) || !context.audioWorklet || typeof AudioWorkletNode === "undefined") {
			throw new Error("Streaming Audio Generator playback requires AudioWorklet support on a live AudioContext.");
		}
		const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, options);
		try {
			await ensureWorklet(context);
			const worklet = new AudioWorkletNode(context, workletName, {
				numberOfInputs: 0,
				numberOfOutputs: 1,
				outputChannelCount: [runtime.graph.channels],
				channelCount: runtime.graph.channels,
				channelCountMode: "explicit",
				processorOptions: { channels: runtime.graph.channels, sourceSampleRate: runtime.graph.sampleRate },
			});
			const source = await CreateSoundSourceAsync(name, worklet, { spatialAutoUpdate: options.spatialAutoUpdate ?? false }, engine);
			return new ScriptableAudioStreamingSound(name, runtime, worklet, source, options);
		} catch (error) {
			runtime.dispose();
			throw error;
		}
	}

	public readonly name: string;

	public get engine(): AudioEngineV2 {
		return this._source.engine;
	}

	public get onDisposeObservable(): Observable<unknown> {
		return this._source.onDisposeObservable as Observable<unknown>;
	}

	public get spatial(): AbstractSpatialAudio {
		return this._source.spatial;
	}

	public get stereo(): AbstractStereoAudio {
		return this._source.stereo;
	}

	public get state(): SoundState {
		return this._state;
	}

	public get currentTime(): number {
		return this._consumedFrames / this._graph.sampleRate;
	}

	public get duration(): number {
		return this._graph.durationSeconds;
	}

	public get volume(): number {
		return this._source.volume;
	}

	public set volume(value: number) {
		this._source.volume = value;
	}

	public get playbackRate(): number {
		return this._playbackRate;
	}

	public set playbackRate(value: number) {
		if (!Number.isFinite(value) || value < 0.01 || value > 4) {
			throw new Error("Generated-audio playbackRate must be from 0.01 through 4.");
		}
		this._playbackRate = value;
		this._worklet.port.postMessage({ type: "rate", value });
	}

	public get loop(): boolean {
		return this._loop;
	}

	public set loop(value: boolean) {
		this._loop = value;
	}

	public get outBus(): PrimaryAudioBus | null {
		return this._source.outBus;
	}

	public set outBus(value: PrimaryAudioBus | null) {
		this._source.outBus = value;
	}

	public get _isSpatial(): boolean {
		return this._source._isSpatial;
	}

	public set _isSpatial(value: boolean) {
		this._source._isSpatial = value;
	}

	/** Delegates mixer ramps to the native Babylon source. */
	public setVolume(value: number, options?: Partial<IAudioParameterRampOptions> | null): void {
		this._source.setVolume(value, options);
	}

	/** Resets the ring to an exact offset, prebuffers it, and starts the worklet. */
	public play(options: Partial<IStaticSoundPlayOptions> = {}): void {
		this._assertAlive();
		if (options.loop !== undefined) {
			this._loop = options.loop;
		}
		if (options.startOffset !== undefined) {
			this.seek(options.startOffset);
		}
		if (this._state === SoundState.Started) {
			return;
		}
		if (this._state === SoundState.Stopped && this._sourceEndSent) {
			this._reset(0);
		}
		this._state = SoundState.Starting;
		this._fillQueue();
		this._worklet.port.postMessage({ type: "playing", value: true });
		this._state = SoundState.Started;
	}

	/** Stops consumption while retaining queued PCM and the exact source position. */
	public pause(): void {
		if (this._state !== SoundState.Started && this._state !== SoundState.Starting) {
			return;
		}
		this._worklet.port.postMessage({ type: "playing", value: false });
		this._state = SoundState.Paused;
	}

	/** Continues a paused ring without regenerating already queued blocks. */
	public resume(): void {
		if (this._state === SoundState.Paused) {
			this.play();
		}
	}

	/** Stops playback and returns generation/consumption cursors to frame zero. */
	public stop(): void {
		if (this._disposed) {
			return;
		}
		this._worklet.port.postMessage({ type: "playing", value: false });
		this._reset(0);
		this._state = SoundState.Stopped;
	}

	/** Clears queued lookahead and repositions the next generated frame. */
	public seek(seconds: number): void {
		if (!Number.isFinite(seconds) || seconds < 0 || seconds > this._graph.durationSeconds) {
			throw new Error(`Generated-audio seek must be from 0 through ${this._graph.durationSeconds} seconds.`);
		}
		const wasPlaying = this._state === SoundState.Started || this._state === SoundState.Starting;
		this._reset(Math.min(this._runtime.frameCount, Math.floor(seconds * this._graph.sampleRate)));
		if (wasPlaying) {
			this._fillQueue();
			this._worklet.port.postMessage({ type: "playing", value: true });
		}
	}

	/** Releases worklet, graph states, Babylon routing, and observables exactly once. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._cleanup();
		this._source.dispose();
	}

	/** Recreates independent custom state and ring ownership for cloned SoundNodes. */
	public cloneAsync(): Promise<ScriptableAudioStreamingSound> {
		return ScriptableAudioStreamingSound.CreateAsync(this.name, this._graph, this._options);
	}

	/** Returns bounded live evidence without exposing worklet ports or callback state. */
	public getPlaybackState(): IScriptableAudioPlaybackState {
		return {
			streaming: true,
			state: stateName(this._state, this._disposed),
			sampleRate: this._graph.sampleRate,
			channels: this._graph.channels,
			durationSeconds: this._graph.durationSeconds,
			generatedFrames: this._nextFrame,
			consumedFrames: this._consumedFrames,
			queuedBlocks: this._queuedBlocks,
			underrunCount: this._underrunCount,
			loop: this._loop,
			playbackRate: this._playbackRate,
			finished: this._sourceEndSent && this._queuedBlocks === 0,
			generationBlocks: this._generationBlocks,
			generationCpuMilliseconds: this._generationCpuMilliseconds,
			diagnostics: this._runtime.diagnostics,
		};
	}

	/** Generates lookahead synchronously and transfers ownership of every block to the worklet. */
	private _fillQueue(): void {
		if (this._disposed || this._sourceEndSent) {
			return;
		}
		while (this._queuedBlocks < targetQueuedBlocks) {
			if (this._nextFrame >= this._runtime.frameCount) {
				if (this._loop) {
					this._nextFrame = 0;
				} else {
					this._sourceEndSent = true;
					this._worklet.port.postMessage({ type: "source-end" });
					break;
				}
			}
			const frameCount = Math.min(streamBlockFrames, this._runtime.frameCount - this._nextFrame);
			const started = performance.now();
			const block = this._runtime.renderFrames(this._nextFrame, frameCount);
			this._generationCpuMilliseconds += Math.max(0, performance.now() - started);
			this._generationBlocks++;
			this._nextFrame += frameCount;
			this._queuedBlocks++;
			this._worklet.port.postMessage(
				{ type: "block", channels: block, frames: frameCount },
				block.map((channel) => channel.buffer)
			);
		}
	}

	/** Coalesces repeated low-water messages into one microtask refill. */
	private _queueRefill(): void {
		if (this._refillQueued || this._disposed) {
			return;
		}
		this._refillQueued = true;
		queueMicrotask(() => {
			this._refillQueued = false;
			if (this._state === SoundState.Started || this._state === SoundState.Starting) {
				this._fillQueue();
			}
		});
	}

	/** Applies bounded worklet progress, backpressure, underrun, and completion messages. */
	private _handleWorkletMessage(message: unknown): void {
		if (!message || typeof message !== "object" || this._disposed) {
			return;
		}
		const value = message as Record<string, unknown>;
		if (value.type === "consumed" && Number.isInteger(value.frames) && (value.frames as number) >= 0) {
			this._consumedFrames = this._loop
				? (this._consumedFrames + (value.frames as number)) % this._runtime.frameCount
				: Math.min(this._runtime.frameCount, this._consumedFrames + (value.frames as number));
			this._queuedBlocks = Number.isInteger(value.queuedBlocks)
				? Math.max(0, Math.min(targetQueuedBlocks, value.queuedBlocks as number))
				: Math.max(0, this._queuedBlocks - 1);
			if (this._queuedBlocks < 4) {
				this._queueRefill();
			}
		} else if (value.type === "need") {
			if (Number.isInteger(value.queuedBlocks)) {
				this._queuedBlocks = Math.max(0, Math.min(targetQueuedBlocks, value.queuedBlocks as number));
			}
			this._queueRefill();
		} else if (value.type === "underrun" && Number.isInteger(value.count)) {
			this._underrunCount = Math.max(this._underrunCount, value.count as number);
		} else if (value.type === "ended") {
			this._queuedBlocks = 0;
			this._state = SoundState.Stopped;
			this.onEndedObservable.notifyObservers(this);
		}
	}

	/** Resets main/worklet cursors while preserving authored loop and playback-rate controls. */
	private _reset(frame: number): void {
		this._nextFrame = frame;
		this._consumedFrames = frame;
		this._queuedBlocks = 0;
		this._sourceEndSent = false;
		this._worklet.port.postMessage({ type: "reset" });
	}

	/** Performs non-recursive teardown whether disposal starts at wrapper or Babylon source. */
	private _cleanup(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._state = SoundState.Stopped;
		this._worklet.port.postMessage({ type: "dispose" });
		this._worklet.disconnect();
		this._runtime.dispose();
		this.onEndedObservable.clear();
	}

	/** Fails controls after disposal instead of mutating a detached native graph. */
	private _assertAlive(): void {
		if (this._disposed) {
			throw new Error("Generated-audio streaming sound is disposed.");
		}
	}
}

/** Creates native static playback for bounded graphs and worklet streaming otherwise. */
export async function createScriptableAudioSoundAsync(name: string, value: unknown, options: ICreateScriptableAudioSoundOptions): Promise<ScriptableAudioSound> {
	const graph = normalizeScriptableAudioGeneratorGraph(value);
	if (graph.streaming) {
		return ScriptableAudioStreamingSound.CreateAsync(name, graph, options);
	}
	const engine = _GetAudioEngine(options.engine ?? null) as _WebAudioEngine;
	const context = engine._audioContext;
	const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, options);
	try {
		const started = performance.now();
		const rendered = runtime.renderAll();
		const generationCpuMilliseconds = Math.max(0, performance.now() - started);
		const buffer = context.createBuffer(rendered.channels.length, rendered.frameCount, rendered.sampleRate);
		rendered.channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
		const sound = await CreateSoundAsync(name, buffer, { spatialAutoUpdate: options.spatialAutoUpdate ?? false }, engine);
		const owner: IStaticPlaybackOwner = { runtime, graph, options, generationCpuMilliseconds, disposed: false };
		staticPlaybackOwners.set(sound, owner);
		sound.onDisposeObservable.addOnce(() => {
			owner.disposed = true;
			runtime.dispose();
		});
		return sound;
	} catch (error) {
		runtime.dispose();
		throw error;
	}
}

/** Clones generated playback with independent custom-node state and native routing. */
export function cloneScriptableAudioSoundAsync(sound: unknown): Promise<ScriptableAudioSound | null> {
	if (sound instanceof ScriptableAudioStreamingSound) {
		return sound.cloneAsync();
	}
	const owner = staticPlaybackOwners.get(sound as StaticSound);
	return owner ? createScriptableAudioSoundAsync((sound as StaticSound).name, owner.graph, owner.options) : Promise.resolve(null);
}

/** Fetches and strictly validates a graph before constructing shared generated playback. */
export async function createScriptableAudioSoundFromUrlAsync(
	name: string,
	url: string,
	rootUrl: string,
	options: Omit<ICreateScriptableAudioSoundOptions, "loadAudioClip"> = {}
): Promise<ScriptableAudioSound> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Unable to load Audio Generator asset "${url}": HTTP ${response.status}.`);
	}
	const engine = _GetAudioEngine(options.engine ?? null) as _WebAudioEngine;
	return createScriptableAudioSoundAsync(name, await response.json(), { ...options, engine, loadAudioClip: createScriptableAudioUrlClipLoader(engine._audioContext, rootUrl) });
}

/** Reads live generated-playback evidence for diagnostics without identifying ordinary sounds as generated. */
export function getScriptableAudioPlaybackState(sound: unknown): IScriptableAudioPlaybackState | null {
	if (sound instanceof ScriptableAudioStreamingSound) {
		return sound.getPlaybackState();
	}
	const owner = staticPlaybackOwners.get(sound as StaticSound);
	if (!owner) {
		return null;
	}
	const staticSound = sound as StaticSound;
	return {
		streaming: false,
		state: stateName(staticSound.state, owner.disposed),
		sampleRate: owner.runtime.graph.sampleRate,
		channels: owner.runtime.graph.channels,
		durationSeconds: owner.runtime.graph.durationSeconds,
		generatedFrames: owner.runtime.frameCount,
		consumedFrames: Math.min(owner.runtime.frameCount, Math.floor(staticSound.currentTime * owner.runtime.graph.sampleRate)),
		queuedBlocks: 0,
		underrunCount: 0,
		loop: staticSound.loop,
		playbackRate: staticSound.playbackRate,
		finished: staticSound.state === SoundState.Stopped && staticSound.currentTime >= owner.runtime.graph.durationSeconds,
		generationBlocks: Math.ceil(owner.runtime.frameCount / streamBlockFrames),
		generationCpuMilliseconds: owner.generationCpuMilliseconds,
		diagnostics: owner.runtime.diagnostics,
	};
}
