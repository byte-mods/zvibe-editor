import { readFile } from "fs/promises";
import { dirname, isAbsolute, join, normalize } from "path/posix";

import { Scene } from "@babylonjs/core/scene";

import {
	IAudioMixerBus,
	IAudioMixerBusRuntime,
	IAudioMixerEffectRuntime,
	IAudioMixerRuntimeState,
	ICinematicAudioTrack,
	ICinematicCapturePlan,
	ICinematicDocument,
	TCinematicTrack,
	createDefaultAudioMixerEffectParameters,
	decodeScriptableAudioClip,
	evaluateCinematicFrame,
	isScriptableAudioGeneratorPath,
	ScriptableAudioGeneratorRuntime,
	validateAudioMixerConfiguration,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../../../project/configuration";

export const cinematicOfflineAudioSampleRate = 48_000;
export const cinematicOfflineAudioChannelCount = 2;
export const maximumCinematicOfflineAudioSeconds = 600;
export const maximumCinematicOfflineAudioSources = 4096;

/** Identifies one Timeline sound and its captured mixer route. */
export interface ICinematicAudioCaptureSourceEvidence {
	trackId: string;
	clipId: string;
	soundId: string;
	busId: string | null;
	busPath: string;
	loaded: boolean;
	streamingFallback: boolean;
	durationSeconds: number | null;
	channelCount: number | null;
	sampleRate: number | null;
}

/** Describes exactly what an audio-enabled capture can render before any file is written. */
export interface ICinematicAudioCaptureInspection {
	ready: boolean;
	mode: "offline-master-bus";
	sampleRate: typeof cinematicOfflineAudioSampleRate;
	channelCount: typeof cinematicOfflineAudioChannelCount;
	durationSeconds: number;
	mediaFrameCount: number;
	container: "webm" | "mp4" | null;
	audioCodec: "opus" | "aac" | null;
	sources: ICinematicAudioCaptureSourceEvidence[];
	mixer: {
		masterPath: "Master";
		busCount: number;
		effectCount: number;
		returnSendCount: number;
		sidechainSendCount: number;
		sidechainMode: "captured-runtime-duck-gain";
	};
	issues: { code: string; message: string; trackId?: string; clipId?: string; soundId?: string }[];
}

/** Carries the rendered PCM plus bounded evidence used by the file sink and MCP status. */
export interface ICinematicRenderedAudio {
	buffer: AudioBuffer;
	inspection: ICinematicAudioCaptureInspection;
}

interface IWebAudioBufferLike {
	duration: number;
	numberOfChannels: number;
	sampleRate: number;
	length: number;
	getChannelData(channel: number): Float32Array;
}

interface IOfflineEffectNodes {
	input: GainNode;
	output: GainNode;
}

interface IOfflineBusNodes {
	input: GainNode;
	output: AudioNode;
	runtime: IAudioMixerBusRuntime;
}

interface IScheduleClipOptions {
	context: OfflineAudioContext;
	document: ICinematicDocument;
	plan: ICinematicCapturePlan;
	clip: ICinematicAudioTrack["clips"][number];
	buffer: AudioBuffer;
	destination: AudioNode;
	pitch: number;
}

/** Returns true for the AudioBuffer surface needed by deterministic offline rendering. */
function isAudioBufferLike(value: unknown): value is AudioBuffer & IWebAudioBufferLike {
	const candidate = value as Partial<IWebAudioBufferLike> | null;
	return (
		!!candidate &&
		typeof candidate.duration === "number" &&
		typeof candidate.numberOfChannels === "number" &&
		typeof candidate.sampleRate === "number" &&
		typeof candidate.length === "number" &&
		typeof candidate.getChannelData === "function"
	);
}

/** Finds the decoded AudioV2 buffer without depending on Babylon's internal concrete class at runtime. */
function loadedSoundBuffer(scene: Scene, soundId: string): (AudioBuffer & IWebAudioBufferLike) | null {
	const node = scene.getNodeById(soundId) as { sound?: { buffer?: { _audioBuffer?: unknown } } } | null;
	const buffer = node?.sound?.buffer?._audioBuffer;
	return isAudioBufferLike(buffer) ? buffer : null;
}

/** Resolves a project-contained SoundNode path for streaming/deferred decode fallback. */
function soundAbsolutePath(scene: Scene, soundId: string): string | null {
	const relativePath = (scene.getNodeById(soundId) as { soundRelativePath?: unknown } | null)?.soundRelativePath;
	if (!projectConfiguration.path || typeof relativePath !== "string" || !relativePath || relativePath.includes("\0") || relativePath.includes("\\") || isAbsolute(relativePath)) {
		return null;
	}
	const root = normalize(dirname(projectConfiguration.path));
	const absolutePath = normalize(join(root, relativePath));
	return absolutePath.startsWith(`${root}/`) ? absolutePath : null;
}

/** Copies a live-context buffer into the offline context that owns the render graph. */
function copyAudioBuffer(context: OfflineAudioContext, source: IWebAudioBufferLike): AudioBuffer {
	const result = context.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
	for (let channel = 0; channel < source.numberOfChannels; channel++) {
		result.copyToChannel(new Float32Array(source.getChannelData(channel)), channel);
	}
	return result;
}

/** Loads a SoundNode into the offline context, including project-file fallback for streaming nodes. */
async function resolveSoundBuffer(context: OfflineAudioContext, scene: Scene, soundId: string): Promise<{ buffer: AudioBuffer; streamingFallback: boolean }> {
	const loaded = loadedSoundBuffer(scene, soundId);
	if (loaded) {
		return { buffer: copyAudioBuffer(context, loaded), streamingFallback: false };
	}
	const absolutePath = soundAbsolutePath(scene, soundId);
	if (!absolutePath) {
		throw new Error(`Cinematic SoundNode "${soundId}" has no decoded buffer or project-contained source path.`);
	}
	if (isScriptableAudioGeneratorPath(absolutePath)) {
		const graph = JSON.parse(await readFile(absolutePath, "utf-8"));
		const root = dirname(projectConfiguration.path!);
		const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, {
			loadAudioClip: async (path) => {
				const bytes = await readFile(join(root, path));
				return decodeScriptableAudioClip(context, Uint8Array.from(bytes).buffer);
			},
		});
		try {
			if (runtime.graph.durationSeconds > maximumCinematicOfflineAudioSeconds) {
				throw new Error(`Cinematic Audio Generator sources are limited to ${maximumCinematicOfflineAudioSeconds} seconds.`);
			}
			const buffer = context.createBuffer(runtime.graph.channels, runtime.frameCount, runtime.graph.sampleRate);
			for (let frame = 0; frame < runtime.frameCount; frame += 2_048) {
				const frameCount = Math.min(2_048, runtime.frameCount - frame);
				const block = runtime.renderFrames(frame, frameCount);
				for (let channel = 0; channel < block.length; channel++) {
					buffer.getChannelData(channel).set(block[channel], frame);
				}
			}
			return { buffer, streamingFallback: true };
		} finally {
			runtime.dispose();
		}
	}
	const bytes = await readFile(absolutePath);
	return { buffer: await context.decodeAudioData(Uint8Array.from(bytes).buffer), streamingFallback: true };
}

/** Evaluates persisted buses without creating a live AudioMixer or mutating read-only MCP inspection state. */
function mixerRuntime(scene: Scene, buses: IAudioMixerBus[]): IAudioMixerRuntimeState {
	if (scene.audioMixer) {
		return scene.audioMixer.peekRuntimeState();
	}
	const byId = new Map(buses.map((bus) => [bus.id, bus]));
	const ancestors = new Map<string, IAudioMixerBus[]>();
	for (const bus of buses) {
		const chain = [bus];
		const visited = new Set([bus.id]);
		let current = bus;
		while (current.parentBusId) {
			const parent = byId.get(current.parentBusId);
			if (!parent || visited.has(parent.id)) {
				break;
			}
			chain.unshift(parent);
			visited.add(parent.id);
			current = parent;
		}
		ancestors.set(bus.id, chain);
	}
	const soloBuses = buses.filter((bus) => bus.solo);
	const pathFor = (bus: IAudioMixerBus): string => `Master/${(ancestors.get(bus.id) ?? [bus]).map((entry) => entry.name).join("/")}`;
	const isRelatedToSolo = (bus: IAudioMixerBus): boolean =>
		!soloBuses.length ||
		soloBuses.some((solo) => ancestors.get(bus.id)?.some((ancestor) => ancestor.id === solo.id) || ancestors.get(solo.id)?.some((ancestor) => ancestor.id === bus.id));
	const runtimeBuses = buses.map((bus): IAudioMixerBusRuntime => {
		const chain = ancestors.get(bus.id) ?? [bus];
		const audible = isRelatedToSolo(bus) && !chain.some((entry) => entry.muted);
		return {
			id: bus.id,
			name: bus.name,
			path: pathFor(bus),
			depth: chain.length,
			parentBusId: bus.parentBusId ?? null,
			gain: bus.gain,
			pitch: bus.pitch ?? 1,
			effectiveGain: audible ? chain.reduce((value, entry) => value * entry.gain, 1) : 0,
			effectivePitch: chain.reduce((value, entry) => value * (entry.pitch ?? 1), 1),
			muted: bus.muted === true,
			solo: bus.solo === true,
			audible,
			assignedSoundCount: bus.soundNodeIds.length,
			incomingSendCount: buses.reduce((count, source) => count + (source.sends ?? []).filter((send) => send.targetBusId === bus.id).length, 0),
			duckGain: 1,
			sends: (bus.sends ?? []).map((send) => ({
				id: send.id,
				name: send.name,
				sourceBusId: bus.id,
				targetBusId: send.targetBusId,
				targetPath: byId.has(send.targetBusId) ? pathFor(byId.get(send.targetBusId)!) : "Missing",
				kind: send.kind,
				gain: send.gain,
				enabled: send.enabled !== false,
				signalLevel: 0,
				duckGain: 1,
				nativeConnected: false,
			})),
			effects: (bus.effects ?? []).map((effect, index) => ({
				id: effect.id,
				name: effect.name,
				type: effect.type,
				index,
				enabled: effect.enabled !== false,
				wet: effect.wet ?? 1,
				parameters: { ...createDefaultAudioMixerEffectParameters(effect.type), ...effect.parameters },
				nativeConnected: false,
			})),
			nativeConnected: false,
		};
	});
	const camera = scene.activeCamera as { globalPosition?: { x: number; y: number; z: number }; position?: { x: number; y: number; z: number } } | null;
	const position = camera?.globalPosition ?? camera?.position;
	return {
		masterPath: "Master",
		buses: runtimeBuses,
		transition: null,
		nativeAudioGraph: false,
		listenerPosition: position ? [position.x, position.y, position.z] : [0, 0, 0],
		reverbZones: [],
		warnings: validateAudioMixerConfiguration(buses),
	};
}

/** Resolves the bus assignment and inherited playback pitch for a SoundNode. */
function routeForSound(soundId: string, buses: IAudioMixerBus[], runtime: IAudioMixerRuntimeState): { busId: string | null; busPath: string; pitch: number } {
	const bus = buses.find((candidate) => candidate.soundNodeIds.includes(soundId));
	const state = bus ? runtime.buses.find((candidate) => candidate.id === bus.id) : null;
	return { busId: bus?.id ?? null, busPath: state?.path ?? "Master", pitch: state?.effectivePitch ?? 1 };
}

/** Lists only Audio tracks that participate after hierarchy mute and solo rules. */
function activeAudioTracks(document: ICinematicDocument): ICinematicAudioTrack[] {
	const byId = new Map(document.tracks.map((track) => [track.id, track]));
	const hasSolo = document.tracks.some((track) => track.solo);
	return document.tracks.filter((track): track is ICinematicAudioTrack => {
		if (track.type !== "audio" || track.muted) {
			return false;
		}
		const ancestors: TCinematicTrack[] = [];
		const visited = new Set([track.id]);
		let parentId = track.parentId;
		while (parentId && !visited.has(parentId)) {
			visited.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) {
				break;
			}
			ancestors.push(parent);
			parentId = parent.parentId;
		}
		return !ancestors.some((parent) => parent.muted) && (!hasSolo || track.solo || ancestors.some((parent) => parent.solo));
	});
}

/** Builds a bounded, side-effect-free preflight used by UI, MCP, validation, and rendering. */
export function inspectCinematicAudioCapture(document: ICinematicDocument, scene: Scene, plan: ICinematicCapturePlan): ICinematicAudioCaptureInspection {
	const durationSeconds = plan.frameCount / plan.profile.framesPerSecond;
	const buses = ((scene.metadata?.babylonEditorAudioBuses ?? []) as IAudioMixerBus[]).map((bus) => structuredClone(bus));
	const runtime = mixerRuntime(scene, buses);
	const issues: ICinematicAudioCaptureInspection["issues"] = validateAudioMixerConfiguration(buses).map((message) => ({ code: "INVALID_AUDIO_MIXER", message }));
	if (plan.profile.includeAudio && plan.profile.format !== "webm" && plan.profile.format !== "mp4") {
		issues.push({ code: "AUDIO_CONTAINER_UNSUPPORTED", message: "Offline audio can be muxed only into WebM or MP4 cinematic captures." });
	}
	if (durationSeconds > maximumCinematicOfflineAudioSeconds) {
		issues.push({ code: "AUDIO_DURATION_LIMIT", message: `Offline audio captures are limited to ${maximumCinematicOfflineAudioSeconds} seconds.` });
	}
	if (typeof OfflineAudioContext === "undefined") {
		issues.push({ code: "OFFLINE_AUDIO_CONTEXT_UNAVAILABLE", message: "This Electron renderer does not provide OfflineAudioContext." });
	}
	const sources: ICinematicAudioCaptureSourceEvidence[] = [];
	for (const track of activeAudioTracks(document)) {
		for (const clip of track.clips) {
			const clipEnd = clip.startFrame + clip.durationFrames;
			const capturesPreExtrapolation = clip.preExtrapolation !== "none" && plan.startFrame < clip.startFrame;
			const capturesPostExtrapolation = clip.postExtrapolation !== "none" && plan.endFrame > clipEnd;
			if (!clip.enabled || (clipEnd <= plan.startFrame && !capturesPostExtrapolation) || (clip.startFrame >= plan.endFrame && !capturesPreExtrapolation)) {
				continue;
			}
			if (capturesPreExtrapolation || capturesPostExtrapolation) {
				issues.push({
					code: "AUDIO_EXTRAPOLATION_UNSUPPORTED",
					message: `Offline audio clip "${clip.name}" must use none outside its authored interval; loop the SoundNode clip itself for deterministic capture.`,
					trackId: track.id,
					clipId: clip.id,
					soundId: clip.soundId,
				});
			}
			const loaded = loadedSoundBuffer(scene, clip.soundId);
			const fallback = soundAbsolutePath(scene, clip.soundId);
			const route = routeForSound(clip.soundId, buses, runtime);
			sources.push({
				trackId: track.id,
				clipId: clip.id,
				soundId: clip.soundId,
				busId: route.busId,
				busPath: route.busPath,
				loaded: !!loaded,
				streamingFallback: !loaded && !!fallback,
				durationSeconds: loaded?.duration ?? null,
				channelCount: loaded?.numberOfChannels ?? null,
				sampleRate: loaded?.sampleRate ?? null,
			});
			if (!loaded && !fallback) {
				issues.push({
					code: "SOUND_SOURCE_UNAVAILABLE",
					message: `Cinematic SoundNode "${clip.soundId}" has no decoded buffer or project-contained source path.`,
					trackId: track.id,
					clipId: clip.id,
					soundId: clip.soundId,
				});
			}
		}
	}
	if (sources.length > maximumCinematicOfflineAudioSources) {
		issues.push({ code: "AUDIO_SOURCE_LIMIT", message: `Offline captures are limited to ${maximumCinematicOfflineAudioSources} active audio clips.` });
	}
	return {
		ready: issues.length === 0,
		mode: "offline-master-bus",
		sampleRate: cinematicOfflineAudioSampleRate,
		channelCount: cinematicOfflineAudioChannelCount,
		durationSeconds,
		mediaFrameCount: Math.ceil(durationSeconds * cinematicOfflineAudioSampleRate),
		container: plan.profile.format === "webm" || plan.profile.format === "mp4" ? plan.profile.format : null,
		audioCodec: plan.profile.format === "webm" ? "opus" : plan.profile.format === "mp4" ? "aac" : null,
		sources,
		mixer: {
			masterPath: "Master",
			busCount: runtime.buses.length,
			effectCount: runtime.buses.reduce((count, bus) => count + bus.effects.length, 0),
			returnSendCount: runtime.buses.reduce((count, bus) => count + bus.sends.filter((send) => send.kind === "return" && send.enabled).length, 0),
			sidechainSendCount: runtime.buses.reduce((count, bus) => count + bus.sends.filter((send) => send.kind === "sidechain" && send.enabled).length, 0),
			sidechainMode: "captured-runtime-duck-gain",
		},
		issues,
	};
}

/** Creates a deterministic WebAudio effect with the same parameter contract as the live mixer. */
function createEffect(context: OfflineAudioContext, effect: IAudioMixerEffectRuntime, durationSeconds: number): IOfflineEffectNodes {
	const input = context.createGain();
	const output = context.createGain();
	const dry = context.createGain();
	const wet = context.createGain();
	input.connect(dry).connect(output);
	dry.gain.value = 1 - (effect.enabled ? effect.wet : 0);
	wet.gain.value = effect.enabled ? effect.wet : 0;
	const numberFor = (name: string): number => effect.parameters[name] as number;
	let processor: AudioNode;
	if (["lowpass", "highpass", "parametricEq"].includes(effect.type)) {
		const filter = context.createBiquadFilter();
		filter.type = effect.type === "parametricEq" ? "peaking" : effect.type === "lowpass" ? "lowpass" : "highpass";
		filter.frequency.value = numberFor("frequency");
		filter.Q.value = numberFor("q");
		filter.gain.value = effect.type === "parametricEq" ? numberFor("gainDb") : 0;
		processor = filter;
	} else if (effect.type === "compressor") {
		const compressor = context.createDynamicsCompressor();
		compressor.threshold.value = numberFor("thresholdDb");
		compressor.knee.value = numberFor("kneeDb");
		compressor.ratio.value = numberFor("ratio");
		compressor.attack.value = numberFor("attackSeconds");
		compressor.release.value = numberFor("releaseSeconds");
		processor = compressor;
	} else if (effect.type === "distortion") {
		const shaper = context.createWaveShaper();
		const amount = numberFor("amount") * 100;
		const curve = new Float32Array(2048);
		for (let index = 0; index < curve.length; index++) {
			const x = (index * 2) / (curve.length - 1) - 1;
			curve[index] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
		}
		shaper.curve = curve;
		shaper.oversample = effect.parameters.oversample as OverSampleType;
		processor = shaper;
	} else if (["echo", "chorus", "flanger"].includes(effect.type)) {
		const delay = context.createDelay(5);
		const feedback = context.createGain();
		delay.delayTime.value = numberFor("delaySeconds");
		feedback.gain.value = numberFor("feedback");
		delay.connect(feedback).connect(delay);
		if (effect.type !== "echo") {
			const oscillator = context.createOscillator();
			const depth = context.createGain();
			oscillator.frequency.value = numberFor("rateHz");
			depth.gain.value = numberFor("depthSeconds");
			oscillator.connect(depth).connect(delay.delayTime);
			oscillator.start(0);
			oscillator.stop(durationSeconds);
		}
		processor = delay;
	} else if (effect.type === "convolutionReverb") {
		const delay = context.createDelay(1);
		const convolver = context.createConvolver();
		const damping = context.createBiquadFilter();
		delay.delayTime.value = numberFor("preDelaySeconds");
		damping.type = "lowpass";
		damping.frequency.value = numberFor("dampingHz");
		const length = Math.max(1, Math.ceil(context.sampleRate * numberFor("decaySeconds")));
		const impulse = context.createBuffer(cinematicOfflineAudioChannelCount, length, context.sampleRate);
		let random = effect.id.split("").reduce((value, character) => ((value * 31) ^ character.charCodeAt(0)) >>> 0, 2166136261);
		for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
			const values = impulse.getChannelData(channel);
			for (let index = 0; index < values.length; index++) {
				random = (1664525 * random + 1013904223) >>> 0;
				values[index] = ((random / 0xffffffff) * 2 - 1) * (1 - index / values.length) ** 2;
			}
		}
		convolver.buffer = impulse;
		delay.connect(convolver).connect(damping).connect(wet).connect(output);
		input.connect(delay);
		return { input, output };
	} else if (effect.type === "stereoPanner") {
		const panner = context.createStereoPanner();
		panner.pan.value = numberFor("pan");
		processor = panner;
	} else {
		const gain = context.createGain();
		gain.gain.value = 10 ** (numberFor("volumeDb") / 20);
		processor = gain;
	}
	input.connect(processor).connect(wet).connect(output);
	return { input, output };
}

/** Connects the persisted bus/effect/send graph to one offline master destination. */
function createMixerGraph(
	context: OfflineAudioContext,
	buses: IAudioMixerBus[],
	runtime: IAudioMixerRuntimeState,
	durationSeconds: number
): { master: GainNode; buses: Map<string, IOfflineBusNodes> } {
	const master = context.createGain();
	master.connect(context.destination);
	const nodes = new Map<string, IOfflineBusNodes>();
	for (const bus of buses) {
		const state = runtime.buses.find((candidate) => candidate.id === bus.id);
		if (!state) {
			continue;
		}
		const input = context.createGain();
		let output: AudioNode = input;
		for (const effect of state.effects) {
			const effectNodes = createEffect(context, effect, durationSeconds);
			output.connect(effectNodes.input);
			output = effectNodes.output;
		}
		const gain = context.createGain();
		gain.gain.value = state.audible ? state.gain * state.duckGain : 0;
		output.connect(gain);
		nodes.set(bus.id, { input, output: gain, runtime: state });
	}
	for (const bus of buses) {
		const source = nodes.get(bus.id);
		if (!source) {
			continue;
		}
		const parent = bus.parentBusId ? nodes.get(bus.parentBusId) : null;
		source.output.connect(parent?.input ?? master);
		for (const send of source.runtime.sends) {
			if (!send.enabled || send.kind !== "return") {
				continue;
			}
			const target = nodes.get(send.targetBusId);
			if (target) {
				const sendGain = context.createGain();
				sendGain.gain.value = send.gain;
				source.output.connect(sendGain).connect(target.input);
			}
		}
	}
	return { master, buses: nodes };
}

/** Schedules one clip's deterministic source timing and frame-sampled volume automation. */
function scheduleClip(options: IScheduleClipOptions): void {
	const { context, document, plan, clip, buffer, destination, pitch } = options;
	const segmentStart = Math.max(plan.startFrame, clip.startFrame);
	const segmentEnd = Math.min(plan.endFrame, clip.startFrame + clip.durationFrames);
	if (segmentEnd <= segmentStart) {
		return;
	}
	const source = context.createBufferSource();
	const gain = context.createGain();
	source.buffer = buffer;
	source.loop = clip.loop;
	source.playbackRate.value = clip.timeScale * pitch;
	source.connect(gain).connect(destination);
	const startSeconds = (segmentStart - plan.startFrame) / document.framesPerSecond;
	const durationSeconds = (segmentEnd - segmentStart) / document.framesPerSecond;
	let offsetSeconds = (clip.clipInFrame + (segmentStart - clip.startFrame) * clip.timeScale) / document.framesPerSecond;
	if (clip.loop && buffer.duration > 0) {
		offsetSeconds = ((offsetSeconds % buffer.duration) + buffer.duration) % buffer.duration;
	}
	if (!clip.loop && offsetSeconds >= buffer.duration) {
		return;
	}
	const automationRate = Math.max(120, plan.profile.framesPerSecond);
	const automationStep = document.framesPerSecond / automationRate;
	for (let frame = segmentStart; frame <= segmentEnd + automationStep * 0.5; frame += automationStep) {
		const timelineFrame = Math.min(segmentEnd, frame);
		const sample = evaluateCinematicFrame(document, timelineFrame).audio.find((candidate) => candidate.clipId === clip.id);
		const time = Math.max(0, (timelineFrame - plan.startFrame) / document.framesPerSecond);
		gain.gain.linearRampToValueAtTime(sample?.volume ?? 0, time);
	}
	source.start(startSeconds, Math.max(0, offsetSeconds));
	source.stop(startSeconds + durationSeconds);
}

/** Renders Timeline SoundNode clips through the current authored mixer into one offline stereo master. */
export async function renderCinematicOfflineAudio(document: ICinematicDocument, scene: Scene, plan: ICinematicCapturePlan): Promise<ICinematicRenderedAudio> {
	const inspection = inspectCinematicAudioCapture(document, scene, plan);
	if (!inspection.ready) {
		throw new Error(`Cinematic offline audio preflight failed: ${inspection.issues.map((issue) => issue.message).join(" ")}`);
	}
	const context = new OfflineAudioContext(inspection.channelCount, inspection.mediaFrameCount, inspection.sampleRate);
	const buses = ((scene.metadata?.babylonEditorAudioBuses ?? []) as IAudioMixerBus[]).map((bus) => structuredClone(bus));
	const runtime = mixerRuntime(scene, buses);
	const graph = createMixerGraph(context, buses, runtime, inspection.durationSeconds);
	const buffers = new Map<string, { buffer: AudioBuffer; streamingFallback: boolean }>();
	for (const track of activeAudioTracks(document)) {
		for (const clip of track.clips) {
			if (!inspection.sources.some((source) => source.clipId === clip.id)) {
				continue;
			}
			let resolved = buffers.get(clip.soundId);
			if (!resolved) {
				resolved = await resolveSoundBuffer(context, scene, clip.soundId);
				buffers.set(clip.soundId, resolved);
			}
			const route = routeForSound(clip.soundId, buses, runtime);
			scheduleClip({
				context,
				document,
				plan,
				clip,
				buffer: resolved.buffer,
				destination: (route.busId ? graph.buses.get(route.busId)?.input : null) ?? graph.master,
				pitch: route.pitch,
			});
		}
	}
	const buffer = await context.startRendering();
	inspection.sources.forEach((source) => {
		const resolved = buffers.get(source.soundId);
		if (resolved) {
			source.streamingFallback = resolved.streamingFallback;
			source.loaded = true;
			source.durationSeconds = resolved.buffer.duration;
			source.channelCount = resolved.buffer.numberOfChannels;
			source.sampleRate = resolved.buffer.sampleRate;
		}
	});
	return { buffer, inspection };
}

/** Encodes an offline AudioBuffer as little-endian 16-bit PCM WAV for FFmpeg muxing. */
export function encodeCinematicAudioWav(buffer: AudioBuffer): Buffer {
	const channelCount = Math.min(cinematicOfflineAudioChannelCount, buffer.numberOfChannels);
	const sampleCount = buffer.length;
	const bytesPerSample = 2;
	const dataLength = sampleCount * channelCount * bytesPerSample;
	const result = Buffer.allocUnsafe(44 + dataLength);
	result.write("RIFF", 0, "ascii");
	result.writeUInt32LE(36 + dataLength, 4);
	result.write("WAVEfmt ", 8, "ascii");
	result.writeUInt32LE(16, 16);
	result.writeUInt16LE(1, 20);
	result.writeUInt16LE(channelCount, 22);
	result.writeUInt32LE(buffer.sampleRate, 24);
	result.writeUInt32LE(buffer.sampleRate * channelCount * bytesPerSample, 28);
	result.writeUInt16LE(channelCount * bytesPerSample, 32);
	result.writeUInt16LE(16, 34);
	result.write("data", 36, "ascii");
	result.writeUInt32LE(dataLength, 40);
	const channels = Array.from({ length: channelCount }, (_value, channel) => buffer.getChannelData(channel));
	let offset = 44;
	for (let index = 0; index < sampleCount; index++) {
		for (const values of channels) {
			const sample = Math.max(-1, Math.min(1, values[index]));
			result.writeInt16LE(sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), offset);
			offset += bytesPerSample;
		}
	}
	return result;
}
