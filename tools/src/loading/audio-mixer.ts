import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";
import { AudioBus, PrimaryAudioBus } from "@babylonjs/core/AudioV2/abstractAudio/audioBus";
import { AudioEngineV2, LastCreatedAudioEngine } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";

export type AudioMixerTransitionShape = "linear" | "exponential" | "logarithmic";
export type AudioMixerSendKind = "return" | "sidechain";
export type AudioMixerEffectType =
	| "gain"
	| "lowpass"
	| "highpass"
	| "parametricEq"
	| "compressor"
	| "distortion"
	| "echo"
	| "chorus"
	| "flanger"
	| "stereoPanner"
	| "convolutionReverb";
export type AudioMixerEffectParameterValue = number | "none" | "2x" | "4x";

export interface IAudioMixerEffect {
	id: string;
	name: string;
	type: AudioMixerEffectType;
	enabled?: boolean;
	wet?: number;
	parameters: Record<string, AudioMixerEffectParameterValue>;
}

export interface IAudioMixerDucking {
	threshold: number;
	ratio: number;
	attackSeconds: number;
	releaseSeconds: number;
	maxReductionDb: number;
}

export type AudioReverbZoneShape = "sphere" | "box";

export interface IAudioReverbZone {
	id: string;
	name: string;
	effectId: string;
	shape: AudioReverbZoneShape;
	position: [number, number, number];
	innerRadius?: number;
	outerRadius?: number;
	size?: [number, number, number];
	blendDistance?: number;
	priority?: number;
	enabled?: boolean;
}

export interface IAudioReverbZoneRuntime extends IAudioReverbZone {
	weight: number;
	distance: number;
	active: boolean;
	targetBusId: string | null;
	targetPath: string | null;
	nativeConnected: boolean;
}

export interface IAudioMixerSend {
	id: string;
	name: string;
	targetBusId: string;
	kind: AudioMixerSendKind;
	gain: number;
	enabled?: boolean;
	ducking?: IAudioMixerDucking;
}

export interface IAudioMixerBus {
	id: string;
	name: string;
	gain: number;
	pitch?: number;
	muted?: boolean;
	solo?: boolean;
	parentBusId?: string | null;
	soundNodeIds: string[];
	sends?: IAudioMixerSend[];
	effects?: IAudioMixerEffect[];
}

export interface IAudioMixerSnapshot {
	id: string;
	name: string;
	gains: Record<string, number>;
	pitches?: Record<string, number>;
	mutes?: Record<string, boolean>;
	solos?: Record<string, boolean>;
	sendGains?: Record<string, number>;
	effectWets?: Record<string, number>;
	effectEnabled?: Record<string, boolean>;
	effectParameters?: Record<string, Record<string, AudioMixerEffectParameterValue>>;
}

export interface IAudioMixerEffectRuntime {
	id: string;
	name: string;
	type: AudioMixerEffectType;
	index: number;
	enabled: boolean;
	wet: number;
	parameters: Record<string, AudioMixerEffectParameterValue>;
	nativeConnected: boolean;
}

export interface IAudioMixerSendRuntime {
	id: string;
	name: string;
	sourceBusId: string;
	targetBusId: string;
	targetPath: string;
	kind: AudioMixerSendKind;
	gain: number;
	enabled: boolean;
	signalLevel: number;
	duckGain: number;
	nativeConnected: boolean;
}

export interface IAudioMixerBusRuntime {
	id: string;
	name: string;
	path: string;
	depth: number;
	parentBusId: string | null;
	gain: number;
	pitch: number;
	effectiveGain: number;
	effectivePitch: number;
	muted: boolean;
	solo: boolean;
	audible: boolean;
	assignedSoundCount: number;
	incomingSendCount: number;
	duckGain: number;
	sends: IAudioMixerSendRuntime[];
	effects: IAudioMixerEffectRuntime[];
	nativeConnected: boolean;
}

export interface IAudioMixerTransitionRuntime {
	snapshotId: string;
	snapshotName: string;
	durationSeconds: number;
	elapsedSeconds: number;
	progress: number;
	shape: AudioMixerTransitionShape;
}

export interface IAudioMixerRuntimeState {
	masterPath: "Master";
	buses: IAudioMixerBusRuntime[];
	transition: IAudioMixerTransitionRuntime | null;
	nativeAudioGraph: boolean;
	listenerPosition: [number, number, number];
	reverbZones: IAudioReverbZoneRuntime[];
	warnings: string[];
}

export interface IAudioMixerProfilerSettings {
	enabled: boolean;
	sampleCapacity: number;
	sampleEveryNUpdates: number;
}

export interface IAudioMixerBusProfileSample {
	busId: string;
	name: string;
	path: string;
	assignedVoiceCount: number;
	playingVoiceCount: number;
	spatialVoiceCount: number;
	streamingVoiceCount: number;
	estimatedPeakLevel: number;
	estimatedClipping: boolean;
	effectCount: number;
	sendCount: number;
	nativeConnected: boolean;
}

export interface IAudioMixerProfileSample {
	updateIndex: number;
	capturedAt: string;
	deltaTimeSeconds: number;
	mixerCpuMilliseconds: number;
	voiceCount: number;
	playingVoiceCount: number;
	spatialVoiceCount: number;
	streamingVoiceCount: number;
	busCount: number;
	effectCount: number;
	sendCount: number;
	activeReverbZoneCount: number;
	nativeBusCount: number;
	nativeEffectCount: number;
	nativeSendCount: number;
	estimatedPeakLevel: number;
	estimatedClippedBusCount: number;
	audioContext: {
		available: boolean;
		state: string | null;
		sampleRate: number | null;
		baseLatencySeconds: number | null;
		outputLatencySeconds: number | null;
		currentTimeSeconds: number | null;
	};
	buses: IAudioMixerBusProfileSample[];
	truncatedBusCount: number;
}

interface IAudioMixerProfilerSummary {
	sampleCount: number;
	totalMixerCpuMilliseconds: number;
	minimumMixerCpuMilliseconds: number;
	maximumMixerCpuMilliseconds: number;
	lastMixerCpuMilliseconds: number;
	maximumVoiceCount: number;
	maximumPlayingVoiceCount: number;
	maximumEstimatedPeakLevel: number;
	clippedSampleCount: number;
}

interface IAudioMixerBusProfilerSummary {
	busId: string;
	name: string;
	path: string;
	sampleCount: number;
	totalEstimatedPeakLevel: number;
	maximumEstimatedPeakLevel: number;
	lastEstimatedPeakLevel: number;
	maximumPlayingVoiceCount: number;
	clippedSampleCount: number;
}

interface IAudioMixerProfilerState {
	settings: IAudioMixerProfilerSettings;
	updateCount: number;
	capturedSampleCount: number;
	droppedSampleCount: number;
	startedAt: string;
	clearedAt: string | null;
	samples: IAudioMixerProfileSample[];
	summary: IAudioMixerProfilerSummary;
	busSummaries: Map<string, IAudioMixerBusProfilerSummary>;
}

interface IAudioMixerTransition {
	snapshot: IAudioMixerSnapshot;
	durationSeconds: number;
	elapsedSeconds: number;
	startedAtMilliseconds: number;
	shape: AudioMixerTransitionShape;
	startGains: Record<string, number>;
	startPitches: Record<string, number>;
	startSendGains: Record<string, number>;
	startEffectWets: Record<string, number>;
	startEffectParameters: Record<string, Record<string, AudioMixerEffectParameterValue>>;
}

interface INativeAudioSend {
	gainNode: GainNode;
	analyserNode: AnalyserNode | null;
}

interface INativeAudioEffect {
	inputNode: GainNode;
	outputNode: GainNode;
	dryGain: GainNode;
	wetGain: GainNode;
	processor: AudioNode;
	secondary?: AudioNode;
	tertiary?: AudioNode;
	feedbackGain?: GainNode;
	lfo?: OscillatorNode;
	lfoDepth?: GainNode;
	nodes: AudioNode[];
	impulseFingerprint?: string;
}

interface INativeAudioEffectChain {
	sourceNode: AudioNode;
	targetNode: AudioNode;
	firstNode: AudioNode;
	lastNode: AudioNode;
	nodes: AudioNode[];
	oscillators: OscillatorNode[];
}

const MAX_AUDIO_BUSES = 128;
const MAX_AUDIO_BUS_DEPTH = 32;
const MAX_AUDIO_ASSIGNMENTS = 2048;
const MAX_AUDIO_SENDS = 512;
const MAX_AUDIO_EFFECTS = 1024;
const MAX_AUDIO_REVERB_ZONES = 128;
const MAX_AUDIO_PROFILE_BUS_DETAILS = 128;

const AUDIO_EFFECT_PARAMETER_SPECS: Record<
	AudioMixerEffectType,
	Record<string, { defaultValue: AudioMixerEffectParameterValue; minimum?: number; maximum?: number; values?: AudioMixerEffectParameterValue[] }>
> = {
	gain: { volumeDb: { defaultValue: 0, minimum: -80, maximum: 24 } },
	lowpass: { frequency: { defaultValue: 12000, minimum: 20, maximum: 20000 }, q: { defaultValue: 0.707, minimum: 0.0001, maximum: 100 } },
	highpass: { frequency: { defaultValue: 80, minimum: 20, maximum: 20000 }, q: { defaultValue: 0.707, minimum: 0.0001, maximum: 100 } },
	parametricEq: {
		frequency: { defaultValue: 1000, minimum: 20, maximum: 20000 },
		q: { defaultValue: 1, minimum: 0.0001, maximum: 100 },
		gainDb: { defaultValue: 0, minimum: -40, maximum: 40 },
	},
	compressor: {
		thresholdDb: { defaultValue: -24, minimum: -100, maximum: 0 },
		kneeDb: { defaultValue: 30, minimum: 0, maximum: 40 },
		ratio: { defaultValue: 12, minimum: 1, maximum: 20 },
		attackSeconds: { defaultValue: 0.003, minimum: 0, maximum: 1 },
		releaseSeconds: { defaultValue: 0.25, minimum: 0, maximum: 1 },
	},
	distortion: { amount: { defaultValue: 0.25, minimum: 0, maximum: 1 }, oversample: { defaultValue: "2x", values: ["none", "2x", "4x"] } },
	echo: { delaySeconds: { defaultValue: 0.25, minimum: 0, maximum: 5 }, feedback: { defaultValue: 0.25, minimum: 0, maximum: 0.95 } },
	chorus: {
		rateHz: { defaultValue: 1.5, minimum: 0.01, maximum: 20 },
		depthSeconds: { defaultValue: 0.003, minimum: 0, maximum: 0.05 },
		delaySeconds: { defaultValue: 0.015, minimum: 0, maximum: 0.1 },
		feedback: { defaultValue: 0.1, minimum: 0, maximum: 0.95 },
	},
	flanger: {
		rateHz: { defaultValue: 0.3, minimum: 0.01, maximum: 20 },
		depthSeconds: { defaultValue: 0.0015, minimum: 0, maximum: 0.02 },
		delaySeconds: { defaultValue: 0.003, minimum: 0, maximum: 0.05 },
		feedback: { defaultValue: 0.35, minimum: 0, maximum: 0.95 },
	},
	stereoPanner: { pan: { defaultValue: 0, minimum: -1, maximum: 1 } },
	convolutionReverb: {
		decaySeconds: { defaultValue: 1.5, minimum: 0.05, maximum: 20 },
		preDelaySeconds: { defaultValue: 0.02, minimum: 0, maximum: 1 },
		dampingHz: { defaultValue: 8000, minimum: 20, maximum: 20000 },
	},
};

export function createDefaultAudioMixerEffectParameters(type: AudioMixerEffectType): Record<string, AudioMixerEffectParameterValue> {
	const specs = AUDIO_EFFECT_PARAMETER_SPECS[type];
	if (!specs) {
		throw new Error(`Unsupported audio effect type "${type}".`);
	}
	return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, spec.defaultValue]));
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function transitionAmount(progress: number, shape: AudioMixerTransitionShape): number {
	const value = Math.min(1, Math.max(0, progress));
	if (shape === "exponential") {
		return (Math.exp(value) - 1) / (Math.E - 1);
	}
	if (shape === "logarithmic") {
		return Math.log(1 + (Math.E - 1) * value);
	}
	return value;
}

function createAudioMixerProfilerSummary(): IAudioMixerProfilerSummary {
	return {
		sampleCount: 0,
		totalMixerCpuMilliseconds: 0,
		minimumMixerCpuMilliseconds: 0,
		maximumMixerCpuMilliseconds: 0,
		lastMixerCpuMilliseconds: 0,
		maximumVoiceCount: 0,
		maximumPlayingVoiceCount: 0,
		maximumEstimatedPeakLevel: 0,
		clippedSampleCount: 0,
	};
}

function createAudioMixerProfilerState(): IAudioMixerProfilerState {
	return {
		settings: { enabled: false, sampleCapacity: 120, sampleEveryNUpdates: 1 },
		updateCount: 0,
		capturedSampleCount: 0,
		droppedSampleCount: 0,
		startedAt: new Date().toISOString(),
		clearedAt: null,
		samples: [],
		summary: createAudioMixerProfilerSummary(),
		busSummaries: new Map(),
	};
}

function normalizeBus(bus: IAudioMixerBus): void {
	bus.pitch ??= 1;
	bus.parentBusId ??= null;
	bus.muted ??= false;
	bus.solo ??= false;
	bus.soundNodeIds ??= [];
	bus.sends ??= [];
	for (const send of bus.sends) {
		send.enabled ??= true;
		send.kind ??= "return";
	}
	bus.effects ??= [];
	for (const effect of bus.effects) {
		effect.enabled ??= true;
		effect.wet ??= 1;
		if (AUDIO_EFFECT_PARAMETER_SPECS[effect.type]) {
			effect.parameters = { ...createDefaultAudioMixerEffectParameters(effect.type), ...(effect.parameters ?? {}) };
		}
	}
}

/** Validates the persisted hierarchy and assignment graph without requiring an audio device. */
export function validateAudioMixerConfiguration(buses: IAudioMixerBus[]): string[] {
	const errors: string[] = [];
	if (buses.length > MAX_AUDIO_BUSES) {
		errors.push(`Audio mixers are limited to ${MAX_AUDIO_BUSES} buses.`);
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	const assignedSounds = new Set<string>();
	let assignmentCount = 0;
	let sendCount = 0;
	let effectCount = 0;
	const sendIds = new Set<string>();
	const effectIds = new Set<string>();
	for (const bus of buses) {
		normalizeBus(bus);
		if (!bus.id || ids.has(bus.id)) {
			errors.push(`Audio bus ids must be non-empty and unique: "${bus.id}".`);
		}
		if (!bus.name.trim() || names.has(bus.name)) {
			errors.push(`Audio bus names must be non-empty and unique: "${bus.name}".`);
		}
		ids.add(bus.id);
		names.add(bus.name);
		if (!finiteInRange(bus.gain, 0, 16)) {
			errors.push(`Audio bus "${bus.name}" gain must be between 0 and 16.`);
		}
		if (!finiteInRange(bus.pitch, 0.01, 4)) {
			errors.push(`Audio bus "${bus.name}" pitch must be between 0.01 and 4.`);
		}
		if (new Set(bus.soundNodeIds).size !== bus.soundNodeIds.length) {
			errors.push(`Audio bus "${bus.name}" contains duplicate SoundNode assignments.`);
		}
		const busSendNames = new Set<string>();
		const busEffectNames = new Set<string>();
		for (const nodeId of bus.soundNodeIds) {
			assignmentCount++;
			if (assignedSounds.has(nodeId)) {
				errors.push(`SoundNode "${nodeId}" is assigned to more than one audio bus.`);
			}
			assignedSounds.add(nodeId);
		}
		for (const send of bus.sends ?? []) {
			sendCount++;
			if (!send.id || sendIds.has(send.id)) {
				errors.push(`Audio send ids must be non-empty and unique: "${send.id}".`);
			}
			sendIds.add(send.id);
			if (!send.name.trim()) {
				errors.push(`Audio sends on bus "${bus.name}" must have a non-empty name.`);
			}
			if (busSendNames.has(send.name)) {
				errors.push(`Audio send names must be unique within bus "${bus.name}": "${send.name}".`);
			}
			busSendNames.add(send.name);
			if (!finiteInRange(send.gain, 0, 16)) {
				errors.push(`Audio send "${send.name}" gain must be between 0 and 16.`);
			}
			if (!["return", "sidechain"].includes(send.kind)) {
				errors.push(`Audio send "${send.name}" has unsupported kind "${send.kind}".`);
			}
			if (send.kind === "sidechain" && !send.ducking) {
				errors.push(`Sidechain send "${send.name}" requires ducking settings.`);
			}
			if (send.kind === "return" && send.ducking) {
				errors.push(`Return send "${send.name}" cannot contain sidechain ducking settings.`);
			}
			if (send.ducking) {
				if (!finiteInRange(send.ducking.threshold, 0.0001, 1)) {
					errors.push(`Sidechain send "${send.name}" threshold must be between 0.0001 and 1.`);
				}
				if (!finiteInRange(send.ducking.ratio, 1, 100)) {
					errors.push(`Sidechain send "${send.name}" ratio must be between 1 and 100.`);
				}
				if (!finiteInRange(send.ducking.attackSeconds, 0, 10) || !finiteInRange(send.ducking.releaseSeconds, 0, 30)) {
					errors.push(`Sidechain send "${send.name}" attack/release must be within 0..10 and 0..30 seconds.`);
				}
				if (!finiteInRange(send.ducking.maxReductionDb, 0, 80)) {
					errors.push(`Sidechain send "${send.name}" maximum reduction must be between 0 and 80 dB.`);
				}
			}
		}
		for (const effect of bus.effects ?? []) {
			effectCount++;
			if (!effect.id || effectIds.has(effect.id)) {
				errors.push(`Audio effect ids must be non-empty and unique: "${effect.id}".`);
			}
			effectIds.add(effect.id);
			if (!effect.name.trim() || busEffectNames.has(effect.name)) {
				errors.push(`Audio effect names must be non-empty and unique within bus "${bus.name}": "${effect.name}".`);
			}
			busEffectNames.add(effect.name);
			if (!finiteInRange(effect.wet, 0, 1)) {
				errors.push(`Audio effect "${effect.name}" wet mix must be between 0 and 1.`);
			}
			const specs = AUDIO_EFFECT_PARAMETER_SPECS[effect.type];
			if (!specs) {
				errors.push(`Audio effect "${effect.name}" has unsupported type "${effect.type}".`);
				continue;
			}
			const keys = Object.keys(effect.parameters ?? {});
			for (const key of keys.filter((key) => !specs[key])) {
				errors.push(`Audio effect "${effect.name}" contains unknown parameter "${key}".`);
			}
			for (const [key, spec] of Object.entries(specs)) {
				const value = effect.parameters?.[key];
				if (spec.values) {
					if (!spec.values.includes(value)) {
						errors.push(`Audio effect "${effect.name}" parameter "${key}" must be one of ${spec.values.join(", ")}.`);
					}
				} else if (!finiteInRange(value, spec.minimum!, spec.maximum!)) {
					errors.push(`Audio effect "${effect.name}" parameter "${key}" must be between ${spec.minimum} and ${spec.maximum}.`);
				}
			}
		}
	}
	if (assignmentCount > MAX_AUDIO_ASSIGNMENTS) {
		errors.push(`Audio mixers are limited to ${MAX_AUDIO_ASSIGNMENTS} SoundNode assignments.`);
	}
	if (sendCount > MAX_AUDIO_SENDS) {
		errors.push(`Audio mixers are limited to ${MAX_AUDIO_SENDS} sends.`);
	}
	if (effectCount > MAX_AUDIO_EFFECTS) {
		errors.push(`Audio mixers are limited to ${MAX_AUDIO_EFFECTS} effects.`);
	}
	const byId = new Map(buses.map((bus) => [bus.id, bus]));
	for (const bus of buses) {
		if (bus.parentBusId && !byId.has(bus.parentBusId)) {
			errors.push(`Audio bus "${bus.name}" references missing parent "${bus.parentBusId}".`);
		}
		for (const send of bus.sends ?? []) {
			if (!byId.has(send.targetBusId)) {
				errors.push(`Audio send "${send.name}" references missing target "${send.targetBusId}".`);
			}
			if (send.targetBusId === bus.id) {
				errors.push(`Audio send "${send.name}" cannot target its own bus.`);
			}
		}
		const visited = new Set<string>();
		let current: IAudioMixerBus | undefined = bus;
		let depth = 0;
		while (current?.parentBusId) {
			if (visited.has(current.id)) {
				errors.push(`Audio bus "${bus.name}" creates a routing cycle.`);
				break;
			}
			visited.add(current.id);
			current = byId.get(current.parentBusId);
			depth++;
			if (depth > MAX_AUDIO_BUS_DEPTH) {
				errors.push(`Audio bus "${bus.name}" exceeds the ${MAX_AUDIO_BUS_DEPTH}-level hierarchy limit.`);
				break;
			}
		}
	}
	const audibleEdges = new Map(
		buses.map((bus) => [
			bus.id,
			[bus.parentBusId, ...(bus.sends ?? []).filter((send) => send.enabled !== false && send.kind === "return").map((send) => send.targetBusId)].filter(Boolean) as string[],
		])
	);
	for (const bus of buses) {
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): boolean => {
			if (visiting.has(id)) {
				return true;
			}
			if (visited.has(id)) {
				return false;
			}
			visiting.add(id);
			const cycle = (audibleEdges.get(id) ?? []).some(visit);
			visiting.delete(id);
			visited.add(id);
			return cycle;
		};
		if (visit(bus.id)) {
			errors.push(`Audio bus "${bus.name}" creates an audible return-routing cycle.`);
		}
	}
	return [...new Set(errors)];
}

function normalizeReverbZone(zone: IAudioReverbZone): void {
	zone.enabled ??= true;
	zone.priority ??= 0;
	zone.innerRadius ??= 0;
	zone.outerRadius ??= 1000;
	zone.size ??= [1000, 1000, 1000];
	zone.blendDistance ??= 100;
}

/** Validates spatial reverb-zone geometry and exact convolution-effect references without an audio device. */
export function validateAudioReverbZones(buses: IAudioMixerBus[], zones: IAudioReverbZone[]): string[] {
	const errors: string[] = [];
	if (zones.length > MAX_AUDIO_REVERB_ZONES) {
		errors.push(`Audio mixers are limited to ${MAX_AUDIO_REVERB_ZONES} reverb zones.`);
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	const effects = new Map<string, { bus: IAudioMixerBus; effect: IAudioMixerEffect }>();
	for (const bus of buses) {
		for (const effect of bus.effects ?? []) {
			effects.set(effect.id, { bus, effect });
		}
	}
	for (const zone of zones) {
		normalizeReverbZone(zone);
		if (!zone.id || ids.has(zone.id)) {
			errors.push(`Audio reverb-zone ids must be non-empty and unique: "${zone.id}".`);
		}
		if (!zone.name.trim() || names.has(zone.name)) {
			errors.push(`Audio reverb-zone names must be non-empty and unique: "${zone.name}".`);
		}
		ids.add(zone.id);
		names.add(zone.name);
		const target = effects.get(zone.effectId);
		if (!target || target.effect.type !== "convolutionReverb") {
			errors.push(`Audio reverb zone "${zone.name}" must target an existing convolutionReverb effect.`);
		}
		if (!["sphere", "box"].includes(zone.shape)) {
			errors.push(`Audio reverb zone "${zone.name}" has unsupported shape "${zone.shape}".`);
		}
		if (!Array.isArray(zone.position) || zone.position.length !== 3 || zone.position.some((value) => !finiteInRange(value, -1_000_000_000, 1_000_000_000))) {
			errors.push(`Audio reverb zone "${zone.name}" position must contain three finite centimeter values.`);
		}
		if (!finiteInRange(zone.priority, -1000, 1000)) {
			errors.push(`Audio reverb zone "${zone.name}" priority must be between -1000 and 1000.`);
		}
		if (zone.shape === "sphere") {
			if (!finiteInRange(zone.innerRadius, 0, 100_000_000) || !finiteInRange(zone.outerRadius, 0, 100_000_000) || zone.innerRadius > zone.outerRadius) {
				errors.push(`Audio reverb zone "${zone.name}" requires 0 <= innerRadius <= outerRadius <= 100000000 cm.`);
			}
		} else if (
			!Array.isArray(zone.size) ||
			zone.size.length !== 3 ||
			zone.size.some((value) => !finiteInRange(value, 0.0001, 100_000_000)) ||
			!finiteInRange(zone.blendDistance, 0, 100_000_000)
		) {
			errors.push(`Audio reverb zone "${zone.name}" box size and blend distance are invalid.`);
		}
	}
	return [...new Set(errors)];
}

/** Shared editor/export mixer with deterministic hierarchy, snapshot blending, and native AudioV2 routing when available. */
export class AudioMixer {
	private _transition: IAudioMixerTransition | null = null;
	private _runtimeState: IAudioMixerRuntimeState = {
		masterPath: "Master",
		buses: [],
		transition: null,
		nativeAudioGraph: false,
		listenerPosition: [0, 0, 0],
		reverbZones: [],
		warnings: [],
	};
	private _renderObserver: Observer<Scene> | null = null;
	private _nativeEngine: AudioEngineV2 | null = null;
	private _nativeBuses = new Map<string, AudioBus>();
	private _nativeTopologyFingerprint = "";
	private _nativeSynchronization: Promise<void> | null = null;
	private _nativeAssignedSoundIds = new Set<string>();
	private _nativeSends = new Map<string, INativeAudioSend>();
	private _nativeEffects = new Map<string, INativeAudioEffect>();
	private _nativeEffectChains = new Map<string, INativeAudioEffectChain>();
	private _duckGains = new Map<string, number>();
	private _signalLevels = new Map<string, number>();
	private _reverbZoneWeights = new Map<string, number>();
	private _lastUpdateMilliseconds = performance.now();
	private _profiler = createAudioMixerProfilerState();

	public constructor(
		private _scene: Scene,
		private _buses: IAudioMixerBus[],
		private _snapshots: IAudioMixerSnapshot[]
	) {
		this._buses.forEach(normalizeBus);
		this.apply();
	}

	public setConfiguration(buses: IAudioMixerBus[], snapshots: IAudioMixerSnapshot[]): void {
		this._buses = buses;
		this._snapshots = snapshots;
		this._buses.forEach(normalizeBus);
		this.apply();
	}

	public start(): void {
		if (this._renderObserver || !this._scene.onBeforeRenderObservable) {
			return;
		}
		this._renderObserver = this._scene.onBeforeRenderObservable.add(() => this.update(Math.max(0, this._scene.getEngine().getDeltaTime() / 1000)));
	}

	public dispose(): void {
		if (this._renderObserver) {
			this._scene.onBeforeRenderObservable.remove(this._renderObserver);
		}
		this._renderObserver = null;
		this._disposeNativeBuses();
	}

	/** Enables/disables bounded Audio Mixer CPU/voice/signal sampling without pretending WebAudio exposes native DSP CPU time. */
	public configureProfiler(settings: Partial<IAudioMixerProfilerSettings>): ReturnType<AudioMixer["getProfile"]> {
		if (settings.enabled !== undefined) {
			if (typeof settings.enabled !== "boolean") {
				throw new Error("Audio profiler enabled must be a boolean.");
			}
			this._profiler.settings.enabled = settings.enabled;
		}
		if (settings.sampleCapacity !== undefined) {
			if (!Number.isInteger(settings.sampleCapacity) || settings.sampleCapacity < 1 || settings.sampleCapacity > 256) {
				throw new Error("Audio profiler sampleCapacity must be an integer from 1 through 256.");
			}
			this._profiler.settings.sampleCapacity = settings.sampleCapacity;
			while (this._profiler.samples.length > settings.sampleCapacity) {
				this._profiler.samples.shift();
				this._profiler.droppedSampleCount++;
			}
		}
		if (settings.sampleEveryNUpdates !== undefined) {
			if (!Number.isInteger(settings.sampleEveryNUpdates) || settings.sampleEveryNUpdates < 1 || settings.sampleEveryNUpdates > 120) {
				throw new Error("Audio profiler sampleEveryNUpdates must be an integer from 1 through 120.");
			}
			this._profiler.settings.sampleEveryNUpdates = settings.sampleEveryNUpdates;
		}
		return this.getProfile();
	}

	/** Clears transient Audio Mixer samples and summaries while retaining profiler settings. */
	public clearProfile(): ReturnType<AudioMixer["getProfile"]> {
		this._profiler.updateCount = 0;
		this._profiler.capturedSampleCount = 0;
		this._profiler.droppedSampleCount = 0;
		this._profiler.startedAt = new Date().toISOString();
		this._profiler.clearedAt = this._profiler.startedAt;
		this._profiler.samples = [];
		this._profiler.summary = createAudioMixerProfilerSummary();
		this._profiler.busSummaries.clear();
		return this.getProfile();
	}

	/** Reads newest-first bounded Audio Mixer samples plus cumulative CPU, voice, latency, signal, and clipping evidence. */
	public getProfile(options: { busId?: string; includeSamples?: boolean; sampleOffset?: number; sampleLimit?: number } = {}): any {
		const offset = Number.isInteger(options.sampleOffset) && Number(options.sampleOffset) >= 0 ? Number(options.sampleOffset) : 0;
		const limit = Number.isInteger(options.sampleLimit) ? Math.min(120, Math.max(1, Number(options.sampleLimit))) : 20;
		const filteredSamples = [...this._profiler.samples]
			.reverse()
			.map((sample) => {
				if (!options.busId) {
					return structuredClone(sample);
				}
				const buses = sample.buses.filter((bus) => bus.busId === options.busId);
				return { ...structuredClone(sample), buses, busCount: buses.length };
			})
			.filter((sample) => !options.busId || sample.buses.length > 0);
		const returnedSamples = options.includeSamples === true ? filteredSamples.slice(offset, offset + limit) : [];
		const summary = this._profiler.summary;
		const busSummaries = [...this._profiler.busSummaries.values()]
			.filter((value) => !options.busId || value.busId === options.busId)
			.map((value) => ({
				...structuredClone(value),
				averageEstimatedPeakLevel: value.sampleCount ? value.totalEstimatedPeakLevel / value.sampleCount : 0,
			}))
			.sort((left, right) => right.maximumEstimatedPeakLevel - left.maximumEstimatedPeakLevel || left.busId.localeCompare(right.busId));
		return {
			settings: structuredClone(this._profiler.settings),
			measurement: {
				cpu: "Synchronous AudioMixer.update wall-clock time; WebAudio does not expose native DSP-thread CPU time.",
				signal: "Estimated from playing source volume and resolved mixer gain; native sidechain analysers remain available in mixer runtime diagnostics.",
				clipping: "Estimated when a resolved bus source peak exceeds 1.0; WebAudio does not expose hardware-output clip counters.",
			},
			startedAt: this._profiler.startedAt,
			clearedAt: this._profiler.clearedAt,
			updateCount: this._profiler.updateCount,
			capturedSampleCount: this._profiler.capturedSampleCount,
			retainedSampleCount: this._profiler.samples.length,
			droppedSampleCount: this._profiler.droppedSampleCount,
			detailBounds: { maximumBusesPerSample: MAX_AUDIO_PROFILE_BUS_DETAILS },
			summary: {
				...structuredClone(summary),
				averageMixerCpuMilliseconds: summary.sampleCount ? summary.totalMixerCpuMilliseconds / summary.sampleCount : 0,
			},
			busSummaries,
			samples: returnedSamples,
			pagination: {
				total: filteredSamples.length,
				count: returnedSamples.length,
				offset,
				hasMore: options.includeSamples === true && offset + returnedSamples.length < filteredSamples.length,
				nextOffset: options.includeSamples === true && offset + returnedSamples.length < filteredSamples.length ? offset + returnedSamples.length : null,
			},
		};
	}

	public applySnapshot(idOrName: string, durationSeconds = 0, shape: AudioMixerTransitionShape = "linear"): boolean {
		const snapshot = this._snapshots.find((value) => value.id === idOrName || value.name === idOrName);
		if (!snapshot) {
			return false;
		}
		if (!finiteInRange(durationSeconds, 0, 120)) {
			throw new Error("Audio snapshot transition duration must be between 0 and 120 seconds.");
		}
		if (!["linear", "exponential", "logarithmic"].includes(shape)) {
			throw new Error(`Unsupported audio snapshot transition shape "${shape}".`);
		}
		if (durationSeconds === 0) {
			this._applySnapshotValues(snapshot, true);
			this._transition = null;
			this.apply();
			return true;
		}
		this._transition = {
			snapshot,
			durationSeconds,
			elapsedSeconds: 0,
			startedAtMilliseconds: performance.now(),
			shape,
			startGains: Object.fromEntries(this._buses.map((bus) => [bus.id, bus.gain])),
			startPitches: Object.fromEntries(this._buses.map((bus) => [bus.id, bus.pitch ?? 1])),
			startSendGains: Object.fromEntries(this._buses.flatMap((bus) => (bus.sends ?? []).map((send) => [send.id, send.gain]))),
			startEffectWets: Object.fromEntries(this._buses.flatMap((bus) => (bus.effects ?? []).map((effect) => [effect.id, effect.wet ?? 1]))),
			startEffectParameters: Object.fromEntries(this._buses.flatMap((bus) => (bus.effects ?? []).map((effect) => [effect.id, structuredClone(effect.parameters)]))),
		};
		this.apply();
		return true;
	}

	public update(deltaSeconds: number): void {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
			throw new Error("Audio mixer delta time must be finite and non-negative.");
		}
		const profilingEnabled = this._profiler.settings.enabled;
		if (profilingEnabled) {
			this._profiler.updateCount++;
		}
		const captureProfile = profilingEnabled && (this._profiler.updateCount - 1) % this._profiler.settings.sampleEveryNUpdates === 0;
		const profileStarted = captureProfile ? performance.now() : 0;
		this._lastUpdateMilliseconds = performance.now();
		if (this._transition) {
			this._transition.elapsedSeconds = Math.min(this._transition.durationSeconds, this._transition.elapsedSeconds + deltaSeconds);
			const progress = this._transition.elapsedSeconds / this._transition.durationSeconds;
			const amount = transitionAmount(progress, this._transition.shape);
			for (const bus of this._buses) {
				const targetGain = this._transition.snapshot.gains[bus.id];
				if (targetGain !== undefined) {
					bus.gain = this._transition.startGains[bus.id] + (targetGain - this._transition.startGains[bus.id]) * amount;
				}
				const targetPitch = this._transition.snapshot.pitches?.[bus.id];
				if (targetPitch !== undefined) {
					bus.pitch = this._transition.startPitches[bus.id] + (targetPitch - this._transition.startPitches[bus.id]) * amount;
				}
				for (const send of bus.sends ?? []) {
					const targetGain = this._transition.snapshot.sendGains?.[send.id];
					if (targetGain !== undefined) {
						send.gain = this._transition.startSendGains[send.id] + (targetGain - this._transition.startSendGains[send.id]) * amount;
					}
				}
				for (const effect of bus.effects ?? []) {
					const targetWet = this._transition.snapshot.effectWets?.[effect.id];
					if (targetWet !== undefined) {
						effect.wet = this._transition.startEffectWets[effect.id] + (targetWet - this._transition.startEffectWets[effect.id]) * amount;
					}
					const targets = this._transition.snapshot.effectParameters?.[effect.id];
					for (const [name, targetValue] of Object.entries(targets ?? {})) {
						const startValue = this._transition.startEffectParameters[effect.id]?.[name];
						if (typeof startValue === "number" && typeof targetValue === "number") {
							effect.parameters[name] = startValue + (targetValue - startValue) * amount;
						}
					}
				}
			}
			if (progress >= 1) {
				this._applySnapshotValues(this._transition.snapshot, true);
				this._transition = null;
			}
		}
		this._updateDucking(deltaSeconds);
		this.apply();
		if (captureProfile) {
			this._publishProfileSample(deltaSeconds, Math.max(0, performance.now() - profileStarted));
		}
	}

	public apply(): void {
		this._buses.forEach(normalizeBus);
		this._runtimeState = this._evaluateRuntime();
		this._applySoundValues();
		this._applyNativeBusValues();
		this._applyNativeEffectValues();
		void this.synchronizeNativeGraph().catch((error) => {
			const warning = `Native AudioV2 graph could not synchronize: ${error instanceof Error ? error.message : String(error)}`;
			if (!this._runtimeState.warnings.includes(warning)) {
				this._runtimeState.warnings.push(warning);
			}
		});
	}

	public getRuntimeState(): IAudioMixerRuntimeState {
		const now = performance.now();
		const wallClockDelta = Math.min(0.25, Math.max(0, (now - this._lastUpdateMilliseconds) / 1000));
		if (this._transition) {
			const wallClockElapsed = Math.max(0, (now - this._transition.startedAtMilliseconds) / 1000);
			if (wallClockElapsed > this._transition.elapsedSeconds) {
				this.update(wallClockElapsed - this._transition.elapsedSeconds);
			}
		} else if (wallClockDelta > 0) {
			this.update(wallClockDelta);
		}
		return structuredClone(this._runtimeState);
	}

	/** Reads the last evaluated mixer state without advancing a wall-clock transition. */
	public peekRuntimeState(): IAudioMixerRuntimeState {
		return structuredClone(this._runtimeState);
	}

	public async synchronizeNativeGraph(): Promise<void> {
		if (this._nativeSynchronization) {
			return this._nativeSynchronization;
		}
		this._nativeSynchronization = this._synchronizeNativeGraph().finally(() => {
			this._nativeSynchronization = null;
		});
		return this._nativeSynchronization;
	}

	private _applySnapshotValues(snapshot: IAudioMixerSnapshot, includeDiscrete: boolean): void {
		for (const bus of this._buses) {
			if (snapshot.gains[bus.id] !== undefined) {
				bus.gain = snapshot.gains[bus.id];
			}
			if (snapshot.pitches?.[bus.id] !== undefined) {
				bus.pitch = snapshot.pitches[bus.id];
			}
			if (includeDiscrete && snapshot.mutes?.[bus.id] !== undefined) {
				bus.muted = snapshot.mutes[bus.id];
			}
			if (includeDiscrete && snapshot.solos?.[bus.id] !== undefined) {
				bus.solo = snapshot.solos[bus.id];
			}
			for (const send of bus.sends ?? []) {
				if (snapshot.sendGains?.[send.id] !== undefined) {
					send.gain = snapshot.sendGains[send.id];
				}
			}
			for (const effect of bus.effects ?? []) {
				if (snapshot.effectWets?.[effect.id] !== undefined) {
					effect.wet = snapshot.effectWets[effect.id];
				}
				if (snapshot.effectParameters?.[effect.id]) {
					effect.parameters = structuredClone(snapshot.effectParameters[effect.id]);
				}
				if (includeDiscrete && snapshot.effectEnabled?.[effect.id] !== undefined) {
					effect.enabled = snapshot.effectEnabled[effect.id];
				}
			}
		}
	}

	private _publishProfileSample(deltaTimeSeconds: number, mixerCpuMilliseconds: number): void {
		const runtime = this._runtimeState;
		const voiceNodes = new Map<string, any>();
		for (const node of ((this._scene as any).transformNodes ?? []) as any[]) {
			if (node?.id && (node.sound !== undefined || node.soundRelativePath !== undefined || node.getClassName?.() === "SoundNode")) {
				voiceNodes.set(node.id, node);
			}
		}
		for (const bus of this._buses) {
			for (const nodeId of bus.soundNodeIds) {
				const node = this._scene.getNodeById(nodeId) as any;
				if (node) {
					voiceNodes.set(nodeId, node);
				}
			}
		}
		const isPlaying = (node: any): boolean => {
			const state = node?.sound?.state;
			return (typeof node?.isPlaying === "function" && node.isPlaying()) || node?.sound?.isPlaying === true || state === 3 || String(state).toLowerCase() === "started";
		};
		const isStreaming = (node: any): boolean => node?.streaming === true || node?.sound?.streaming === true || node?.sound?._options?.streaming === true;
		const playingNodes = [...voiceNodes.values()].filter(isPlaying);
		const busSamples = runtime.buses.slice(0, MAX_AUDIO_PROFILE_BUS_DETAILS).map((runtimeBus): IAudioMixerBusProfileSample => {
			const definition = this._buses.find((bus) => bus.id === runtimeBus.id)!;
			const nodes = definition.soundNodeIds.map((nodeId) => voiceNodes.get(nodeId)).filter(Boolean);
			const playing = nodes.filter(isPlaying);
			const estimatedPeakLevel = playing.reduce((peak, node) => {
				const baseVolume = node.metadata?.babylonEditorAudioBusBaseVolume ?? (typeof node.volume === "number" ? node.volume : 1);
				return Math.max(peak, Math.max(0, baseVolume) * runtimeBus.effectiveGain);
			}, 0);
			return {
				busId: runtimeBus.id,
				name: runtimeBus.name,
				path: runtimeBus.path,
				assignedVoiceCount: nodes.length,
				playingVoiceCount: playing.length,
				spatialVoiceCount: nodes.filter((node) => node.isSpatial === true).length,
				streamingVoiceCount: nodes.filter(isStreaming).length,
				estimatedPeakLevel,
				estimatedClipping: estimatedPeakLevel > 1,
				effectCount: runtimeBus.effects.length,
				sendCount: runtimeBus.sends.length,
				nativeConnected: runtimeBus.nativeConnected,
			};
		});
		const context = (this._nativeEngine as (AudioEngineV2 & { _audioContext?: AudioContext }) | null)?._audioContext;
		const sample: IAudioMixerProfileSample = {
			updateIndex: this._profiler.updateCount,
			capturedAt: new Date().toISOString(),
			deltaTimeSeconds,
			mixerCpuMilliseconds,
			voiceCount: voiceNodes.size,
			playingVoiceCount: playingNodes.length,
			spatialVoiceCount: [...voiceNodes.values()].filter((node) => node.isSpatial === true).length,
			streamingVoiceCount: [...voiceNodes.values()].filter(isStreaming).length,
			busCount: runtime.buses.length,
			effectCount: runtime.buses.reduce((total, bus) => total + bus.effects.length, 0),
			sendCount: runtime.buses.reduce((total, bus) => total + bus.sends.length, 0),
			activeReverbZoneCount: runtime.reverbZones.filter((zone) => zone.active && zone.weight > 0).length,
			nativeBusCount: runtime.buses.filter((bus) => bus.nativeConnected).length,
			nativeEffectCount: runtime.buses.reduce((total, bus) => total + bus.effects.filter((effect) => effect.nativeConnected).length, 0),
			nativeSendCount: runtime.buses.reduce((total, bus) => total + bus.sends.filter((send) => send.nativeConnected).length, 0),
			estimatedPeakLevel: busSamples.reduce((peak, bus) => Math.max(peak, bus.estimatedPeakLevel), 0),
			estimatedClippedBusCount: busSamples.filter((bus) => bus.estimatedClipping).length,
			audioContext: {
				available: !!context,
				state: context?.state ?? null,
				sampleRate: context?.sampleRate ?? null,
				baseLatencySeconds: typeof context?.baseLatency === "number" ? context.baseLatency : null,
				outputLatencySeconds: typeof (context as any)?.outputLatency === "number" ? (context as any).outputLatency : null,
				currentTimeSeconds: typeof context?.currentTime === "number" ? context.currentTime : null,
			},
			buses: busSamples,
			truncatedBusCount: Math.max(0, runtime.buses.length - busSamples.length),
		};
		this._profiler.capturedSampleCount++;
		const summary = this._profiler.summary;
		summary.sampleCount++;
		summary.totalMixerCpuMilliseconds += mixerCpuMilliseconds;
		summary.minimumMixerCpuMilliseconds = summary.sampleCount === 1 ? mixerCpuMilliseconds : Math.min(summary.minimumMixerCpuMilliseconds, mixerCpuMilliseconds);
		summary.maximumMixerCpuMilliseconds = Math.max(summary.maximumMixerCpuMilliseconds, mixerCpuMilliseconds);
		summary.lastMixerCpuMilliseconds = mixerCpuMilliseconds;
		summary.maximumVoiceCount = Math.max(summary.maximumVoiceCount, sample.voiceCount);
		summary.maximumPlayingVoiceCount = Math.max(summary.maximumPlayingVoiceCount, sample.playingVoiceCount);
		summary.maximumEstimatedPeakLevel = Math.max(summary.maximumEstimatedPeakLevel, sample.estimatedPeakLevel);
		if (sample.estimatedClippedBusCount > 0) {
			summary.clippedSampleCount++;
		}
		for (const bus of busSamples) {
			let busSummary = this._profiler.busSummaries.get(bus.busId);
			if (!busSummary) {
				busSummary = {
					busId: bus.busId,
					name: bus.name,
					path: bus.path,
					sampleCount: 0,
					totalEstimatedPeakLevel: 0,
					maximumEstimatedPeakLevel: 0,
					lastEstimatedPeakLevel: 0,
					maximumPlayingVoiceCount: 0,
					clippedSampleCount: 0,
				};
				this._profiler.busSummaries.set(bus.busId, busSummary);
			}
			busSummary.name = bus.name;
			busSummary.path = bus.path;
			busSummary.sampleCount++;
			busSummary.totalEstimatedPeakLevel += bus.estimatedPeakLevel;
			busSummary.maximumEstimatedPeakLevel = Math.max(busSummary.maximumEstimatedPeakLevel, bus.estimatedPeakLevel);
			busSummary.lastEstimatedPeakLevel = bus.estimatedPeakLevel;
			busSummary.maximumPlayingVoiceCount = Math.max(busSummary.maximumPlayingVoiceCount, bus.playingVoiceCount);
			if (bus.estimatedClipping) {
				busSummary.clippedSampleCount++;
			}
		}
		this._profiler.samples.push(sample);
		while (this._profiler.samples.length > this._profiler.settings.sampleCapacity) {
			this._profiler.samples.shift();
			this._profiler.droppedSampleCount++;
		}
	}

	private _evaluateRuntime(): IAudioMixerRuntimeState {
		const warnings = validateAudioMixerConfiguration(this._buses);
		const zoneDefinitions = ((this._scene.metadata?.babylonEditorAudioReverbZones ?? []) as IAudioReverbZone[]).map((zone) => zone);
		warnings.push(...validateAudioReverbZones(this._buses, zoneDefinitions));
		const byId = new Map(this._buses.map((bus) => [bus.id, bus]));
		const ancestors = new Map<string, IAudioMixerBus[]>();
		for (const bus of this._buses) {
			const chain: IAudioMixerBus[] = [bus];
			const visited = new Set([bus.id]);
			let current = bus;
			while (current.parentBusId && chain.length <= MAX_AUDIO_BUS_DEPTH) {
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
		const soloBuses = this._buses.filter((bus) => bus.solo);
		const pathFor = (bus: IAudioMixerBus): string => `Master/${(ancestors.get(bus.id) ?? [bus]).map((entry) => entry.name).join("/")}`;
		const duckGainByBus = new Map(this._buses.map((bus) => [bus.id, 1]));
		for (const source of this._buses) {
			for (const send of source.sends ?? []) {
				if (send.enabled !== false && send.kind === "sidechain") {
					duckGainByBus.set(send.targetBusId, (duckGainByBus.get(send.targetBusId) ?? 1) * (this._duckGains.get(send.id) ?? 1));
				}
			}
		}
		const isRelatedToSolo = (bus: IAudioMixerBus): boolean =>
			!soloBuses.length ||
			soloBuses.some((solo) => ancestors.get(bus.id)?.some((ancestor) => ancestor.id === solo.id) || ancestors.get(solo.id)?.some((ancestor) => ancestor.id === bus.id));
		const runtimeBuses = this._buses.map((bus): IAudioMixerBusRuntime => {
			const chain = ancestors.get(bus.id) ?? [bus];
			const audible = isRelatedToSolo(bus) && !chain.some((entry) => entry.muted);
			const effectiveGain = audible ? chain.reduce((value, entry) => value * entry.gain * (duckGainByBus.get(entry.id) ?? 1), 1) : 0;
			const effectivePitch = chain.reduce((value, entry) => value * (entry.pitch ?? 1), 1);
			const sends = (bus.sends ?? []).map(
				(send): IAudioMixerSendRuntime => ({
					id: send.id,
					name: send.name,
					sourceBusId: bus.id,
					targetBusId: send.targetBusId,
					targetPath: byId.has(send.targetBusId) ? pathFor(byId.get(send.targetBusId)!) : "Missing",
					kind: send.kind,
					gain: send.gain,
					enabled: send.enabled !== false,
					signalLevel: this._signalLevels.get(send.id) ?? 0,
					duckGain: this._duckGains.get(send.id) ?? 1,
					nativeConnected: this._nativeSends.has(send.id),
				})
			);
			const effects = (bus.effects ?? []).map(
				(effect, index): IAudioMixerEffectRuntime => ({
					id: effect.id,
					name: effect.name,
					type: effect.type,
					index,
					enabled: effect.enabled !== false,
					wet: effect.wet ?? 1,
					parameters: structuredClone(effect.parameters),
					nativeConnected: this._nativeEffects.has(effect.id),
				})
			);
			return {
				id: bus.id,
				name: bus.name,
				path: pathFor(bus),
				depth: chain.length,
				parentBusId: bus.parentBusId ?? null,
				gain: bus.gain,
				pitch: bus.pitch ?? 1,
				effectiveGain,
				effectivePitch,
				muted: bus.muted === true,
				solo: bus.solo === true,
				audible,
				assignedSoundCount: bus.soundNodeIds.length,
				incomingSendCount: this._buses.reduce((count, source) => count + (source.sends ?? []).filter((send) => send.targetBusId === bus.id).length, 0),
				duckGain: duckGainByBus.get(bus.id) ?? 1,
				sends,
				effects,
				nativeConnected: this._nativeBuses.has(bus.id),
			};
		});
		const transition = this._transition
			? {
					snapshotId: this._transition.snapshot.id,
					snapshotName: this._transition.snapshot.name,
					durationSeconds: this._transition.durationSeconds,
					elapsedSeconds: this._transition.elapsedSeconds,
					progress: this._transition.elapsedSeconds / this._transition.durationSeconds,
					shape: this._transition.shape,
				}
			: null;
		const { listenerPosition, zones } = this._evaluateReverbZones(zoneDefinitions, pathFor);
		return { masterPath: "Master", buses: runtimeBuses, transition, nativeAudioGraph: this._nativeBuses.size > 0, listenerPosition, reverbZones: zones, warnings };
	}

	private _evaluateReverbZones(
		definitions: IAudioReverbZone[],
		pathFor: (bus: IAudioMixerBus) => string
	): { listenerPosition: [number, number, number]; zones: IAudioReverbZoneRuntime[] } {
		const camera = this._scene.activeCamera as any;
		const position =
			typeof camera?.computeWorldMatrix === "function"
				? camera.computeWorldMatrix(true).getTranslation()
				: typeof camera?.getAbsolutePosition === "function"
					? camera.getAbsolutePosition()
					: (camera?.globalPosition ?? camera?.position ?? { x: 0, y: 0, z: 0 });
		const listenerPosition: [number, number, number] = [Number(position.x) || 0, Number(position.y) || 0, Number(position.z) || 0];
		const effectTargets = new Map<string, IAudioMixerBus>();
		for (const bus of this._buses) {
			for (const effect of bus.effects ?? []) {
				if (effect.type === "convolutionReverb") {
					effectTargets.set(effect.id, bus);
				}
			}
		}
		const candidates = new Map<string, Array<{ zone: IAudioReverbZone; weight: number; distance: number }>>();
		const measured = definitions.map((zone) => {
			normalizeReverbZone(zone);
			const delta = [listenerPosition[0] - zone.position[0], listenerPosition[1] - zone.position[1], listenerPosition[2] - zone.position[2]];
			let distance: number;
			let weight: number;
			if (zone.shape === "sphere") {
				distance = Math.hypot(delta[0], delta[1], delta[2]);
				const inner = zone.innerRadius!;
				const outer = zone.outerRadius!;
				weight = distance <= inner ? 1 : distance >= outer || outer === inner ? 0 : 1 - (distance - inner) / (outer - inner);
			} else {
				const half = zone.size!.map((value) => value / 2);
				const outside = delta.map((value, index) => Math.max(0, Math.abs(value) - half[index]));
				distance = Math.hypot(outside[0], outside[1], outside[2]);
				weight = distance === 0 ? 1 : distance >= zone.blendDistance! || zone.blendDistance === 0 ? 0 : 1 - distance / zone.blendDistance!;
			}
			weight = zone.enabled === false || !effectTargets.has(zone.effectId) ? 0 : Math.min(1, Math.max(0, weight));
			if (weight > 0) {
				const list = candidates.get(zone.effectId) ?? [];
				list.push({ zone, weight, distance });
				candidates.set(zone.effectId, list);
			}
			return { zone, weight, distance };
		});
		const activeIds = new Set<string>();
		this._reverbZoneWeights.clear();
		for (const [effectId, entries] of candidates) {
			entries.sort((left, right) => (right.zone.priority ?? 0) - (left.zone.priority ?? 0) || right.weight - left.weight || left.zone.id.localeCompare(right.zone.id));
			const selected = entries[0];
			activeIds.add(selected.zone.id);
			this._reverbZoneWeights.set(effectId, selected.weight);
		}
		const zones = measured.map(({ zone, weight, distance }): IAudioReverbZoneRuntime => {
			const targetBus = effectTargets.get(zone.effectId) ?? null;
			return {
				...structuredClone(zone),
				weight,
				distance,
				active: activeIds.has(zone.id),
				targetBusId: targetBus?.id ?? null,
				targetPath: targetBus ? pathFor(targetBus) : null,
				nativeConnected: this._nativeEffects.has(zone.effectId),
			};
		});
		return { listenerPosition, zones };
	}

	private _updateDucking(deltaSeconds: number): void {
		const activeSendIds = new Set<string>();
		for (const source of this._buses) {
			for (const send of source.sends ?? []) {
				activeSendIds.add(send.id);
				const nativeLevel = this._readNativeSendLevel(send.id);
				const fallbackLevel = this._estimateBusSignal(source.id) * send.gain;
				const signalLevel = send.enabled === false ? 0 : Math.min(16, Math.max(nativeLevel, fallbackLevel));
				this._signalLevels.set(send.id, signalLevel);
				if (send.kind !== "sidechain" || !send.ducking) {
					this._duckGains.set(send.id, 1);
					continue;
				}
				const settings = send.ducking;
				let targetGain = 1;
				if (send.enabled !== false && signalLevel > settings.threshold && settings.ratio > 1) {
					const overThresholdDb = 20 * Math.log10(signalLevel / settings.threshold);
					const reductionDb = Math.min(settings.maxReductionDb, overThresholdDb * (1 - 1 / settings.ratio));
					targetGain = 10 ** (-reductionDb / 20);
				}
				const currentGain = this._duckGains.get(send.id) ?? 1;
				const duration = targetGain < currentGain ? settings.attackSeconds : settings.releaseSeconds;
				const amount = duration === 0 ? 1 : 1 - Math.exp(-deltaSeconds / duration);
				this._duckGains.set(send.id, currentGain + (targetGain - currentGain) * amount);
			}
		}
		for (const id of [...this._duckGains.keys()]) {
			if (!activeSendIds.has(id)) {
				this._duckGains.delete(id);
				this._signalLevels.delete(id);
			}
		}
	}

	private _estimateBusSignal(busId: string): number {
		const byId = new Map(this._buses.map((bus) => [bus.id, bus]));
		const isInBusTree = (candidate: IAudioMixerBus): boolean => {
			let current: IAudioMixerBus | undefined = candidate;
			const visited = new Set<string>();
			while (current && !visited.has(current.id)) {
				if (current.id === busId) {
					return true;
				}
				visited.add(current.id);
				current = current.parentBusId ? byId.get(current.parentBusId) : undefined;
			}
			return false;
		};
		let level = 0;
		for (const bus of this._buses.filter(isInBusTree)) {
			for (const nodeId of bus.soundNodeIds) {
				const node = this._scene.getNodeById(nodeId) as any;
				const state = node?.sound?.state;
				const playing =
					(typeof node?.isPlaying === "function" && node.isPlaying()) || node?.sound?.isPlaying === true || state === 3 || String(state).toLowerCase() === "started";
				if (playing) {
					const baseVolume = node.metadata?.babylonEditorAudioBusBaseVolume ?? (typeof node.volume === "number" ? node.volume : 1);
					level = Math.max(level, Math.max(0, baseVolume));
				}
			}
		}
		return level;
	}

	private _readNativeSendLevel(sendId: string): number {
		const analyser = this._nativeSends.get(sendId)?.analyserNode;
		if (!analyser) {
			return 0;
		}
		const values = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(values);
		if (!values.length) {
			return 0;
		}
		let sum = 0;
		for (const value of values) {
			sum += value * value;
		}
		return Math.sqrt(sum / values.length);
	}

	private _applySoundValues(): void {
		const assigned = new Set<string>();
		for (const runtimeBus of this._runtimeState.buses) {
			const bus = this._buses.find((value) => value.id === runtimeBus.id)!;
			for (const id of bus.soundNodeIds) {
				if (assigned.has(id)) {
					continue;
				}
				assigned.add(id);
				const node = this._scene.getNodeById(id) as any;
				if (!node || typeof node.volume !== "number") {
					continue;
				}
				node.metadata ??= {};
				const baseVolume = node.metadata.babylonEditorAudioBusBaseVolume ?? node.volume;
				node.metadata.babylonEditorAudioBusBaseVolume = baseVolume;
				const nativeConnected = this._nativeBuses.has(bus.id) && node.sound?.outBus === this._nativeBuses.get(bus.id);
				node.volume = nativeConnected ? baseVolume : baseVolume * runtimeBus.effectiveGain;
				const currentPlaybackRate = typeof node.playbackRate === "number" ? node.playbackRate : node.sound && "playbackRate" in node.sound ? node.sound.playbackRate : null;
				if (typeof currentPlaybackRate === "number") {
					const basePlaybackRate = node.metadata.babylonEditorAudioBusBasePlaybackRate ?? currentPlaybackRate;
					node.metadata.babylonEditorAudioBusBasePlaybackRate = basePlaybackRate;
					if (typeof node.playbackRate === "number") {
						node.playbackRate = basePlaybackRate * runtimeBus.effectivePitch;
					} else {
						node.sound.playbackRate = basePlaybackRate * runtimeBus.effectivePitch;
					}
				}
			}
		}
		for (const node of (this._scene.transformNodes ?? []) as any[]) {
			if (assigned.has(node.id) || !node.metadata) {
				continue;
			}
			if (typeof node.metadata.babylonEditorAudioBusBaseVolume === "number" && typeof node.volume === "number") {
				node.volume = node.metadata.babylonEditorAudioBusBaseVolume;
				delete node.metadata.babylonEditorAudioBusBaseVolume;
			}
			if (typeof node.metadata.babylonEditorAudioBusBasePlaybackRate === "number") {
				if (typeof node.playbackRate === "number") {
					node.playbackRate = node.metadata.babylonEditorAudioBusBasePlaybackRate;
				} else if (node.sound && "playbackRate" in node.sound) {
					node.sound.playbackRate = node.metadata.babylonEditorAudioBusBasePlaybackRate;
				}
				delete node.metadata.babylonEditorAudioBusBasePlaybackRate;
			}
		}
	}

	private _applyNativeBusValues(): void {
		for (const runtimeBus of this._runtimeState.buses) {
			const nativeBus = this._nativeBuses.get(runtimeBus.id);
			if (nativeBus) {
				nativeBus.volume = runtimeBus.audible ? runtimeBus.gain * runtimeBus.duckGain : 0;
			}
			for (const send of runtimeBus.sends) {
				const nativeSend = this._nativeSends.get(send.id);
				if (nativeSend) {
					nativeSend.gainNode.gain.value = send.enabled ? send.gain : 0;
				}
			}
		}
	}

	private _createNativeEffect(context: AudioContext, effect: IAudioMixerEffect): INativeAudioEffect {
		const inputNode = context.createGain();
		const outputNode = context.createGain();
		const dryGain = context.createGain();
		const wetGain = context.createGain();
		let processor: AudioNode;
		let secondary: AudioNode | undefined;
		let tertiary: AudioNode | undefined;
		let feedbackGain: GainNode | undefined;
		let lfo: OscillatorNode | undefined;
		let lfoDepth: GainNode | undefined;
		if (["lowpass", "highpass", "parametricEq"].includes(effect.type)) {
			processor = context.createBiquadFilter();
		} else if (effect.type === "compressor") {
			processor = context.createDynamicsCompressor();
		} else if (effect.type === "distortion") {
			processor = context.createWaveShaper();
		} else if (["echo", "chorus", "flanger"].includes(effect.type)) {
			const delay = context.createDelay(5);
			processor = delay;
			feedbackGain = context.createGain();
			delay.connect(feedbackGain);
			feedbackGain.connect(delay);
			if (effect.type !== "echo") {
				lfo = context.createOscillator();
				lfoDepth = context.createGain();
				lfo.connect(lfoDepth);
				lfoDepth.connect(delay.delayTime);
				lfo.start();
			}
		} else if (effect.type === "convolutionReverb") {
			processor = context.createDelay(1);
			secondary = context.createConvolver();
			const damping = context.createBiquadFilter();
			damping.type = "lowpass";
			tertiary = damping;
			processor.connect(secondary);
			secondary.connect(tertiary);
		} else if (effect.type === "stereoPanner") {
			processor = context.createStereoPanner();
		} else {
			processor = context.createGain();
		}
		inputNode.connect(dryGain);
		dryGain.connect(outputNode);
		inputNode.connect(processor);
		(tertiary ?? secondary ?? processor).connect(wetGain);
		wetGain.connect(outputNode);
		const nodes: AudioNode[] = [inputNode, outputNode, dryGain, wetGain, processor];
		if (secondary) {
			nodes.push(secondary);
		}
		if (tertiary) {
			nodes.push(tertiary);
		}
		if (feedbackGain) {
			nodes.push(feedbackGain);
		}
		if (lfo) {
			nodes.push(lfo);
		}
		if (lfoDepth) {
			nodes.push(lfoDepth);
		}
		return { inputNode, outputNode, dryGain, wetGain, processor, secondary, tertiary, feedbackGain, lfo, lfoDepth, nodes };
	}

	private _applyNativeEffectValues(): void {
		for (const bus of this._buses) {
			for (const effect of bus.effects ?? []) {
				const native = this._nativeEffects.get(effect.id);
				if (!native) {
					continue;
				}
				const zoneDefinitions = (this._scene.metadata?.babylonEditorAudioReverbZones ?? []) as IAudioReverbZone[];
				const zoneWeight =
					effect.type === "convolutionReverb" && zoneDefinitions.some((zone) => zone.effectId === effect.id) ? (this._reverbZoneWeights.get(effect.id) ?? 0) : 1;
				const wet = effect.enabled === false ? 0 : (effect.wet ?? 1) * zoneWeight;
				native.dryGain.gain.value = 1 - wet;
				native.wetGain.gain.value = wet;
				const numberFor = (name: string): number => effect.parameters[name] as number;
				if (["lowpass", "highpass", "parametricEq"].includes(effect.type)) {
					const filter = native.processor as BiquadFilterNode;
					filter.type = effect.type === "parametricEq" ? "peaking" : effect.type === "lowpass" ? "lowpass" : "highpass";
					filter.frequency.value = numberFor("frequency");
					filter.Q.value = numberFor("q");
					filter.gain.value = effect.type === "parametricEq" ? numberFor("gainDb") : 0;
				} else if (effect.type === "compressor") {
					const compressor = native.processor as DynamicsCompressorNode;
					compressor.threshold.value = numberFor("thresholdDb");
					compressor.knee.value = numberFor("kneeDb");
					compressor.ratio.value = numberFor("ratio");
					compressor.attack.value = numberFor("attackSeconds");
					compressor.release.value = numberFor("releaseSeconds");
				} else if (effect.type === "distortion") {
					const shaper = native.processor as WaveShaperNode;
					const amount = numberFor("amount") * 100;
					const curve = new Float32Array(2048);
					for (let index = 0; index < curve.length; index++) {
						const x = (index * 2) / (curve.length - 1) - 1;
						curve[index] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
					}
					shaper.curve = curve;
					shaper.oversample = effect.parameters.oversample as OverSampleType;
				} else if (["echo", "chorus", "flanger"].includes(effect.type)) {
					const delay = native.processor as DelayNode;
					delay.delayTime.value = numberFor("delaySeconds");
					native.feedbackGain!.gain.value = numberFor("feedback");
					if (native.lfo && native.lfoDepth) {
						native.lfo.frequency.value = numberFor("rateHz");
						native.lfoDepth.gain.value = numberFor("depthSeconds");
					}
				} else if (effect.type === "convolutionReverb") {
					const delay = native.processor as DelayNode;
					const convolver = native.secondary as ConvolverNode;
					const damping = native.tertiary as BiquadFilterNode;
					delay.delayTime.value = numberFor("preDelaySeconds");
					damping.frequency.value = numberFor("dampingHz");
					const fingerprint = `${convolver.context.sampleRate}:${numberFor("decaySeconds")}`;
					if (native.impulseFingerprint !== fingerprint) {
						const sampleRate = convolver.context.sampleRate;
						const decaySeconds = numberFor("decaySeconds");
						const length = Math.max(1, Math.ceil(sampleRate * decaySeconds));
						const impulse = convolver.context.createBuffer(2, length, sampleRate);
						let random = effect.id.split("").reduce((value, character) => ((value * 31) ^ character.charCodeAt(0)) >>> 0, 2166136261);
						for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
							const samples = impulse.getChannelData(channel);
							for (let index = 0; index < samples.length; index++) {
								random = (1664525 * random + 1013904223) >>> 0;
								const noise = (random / 0xffffffff) * 2 - 1;
								samples[index] = noise * (1 - index / samples.length) ** 2;
							}
						}
						convolver.buffer = impulse;
						native.impulseFingerprint = fingerprint;
					}
				} else if (effect.type === "stereoPanner") {
					(native.processor as StereoPannerNode).pan.value = numberFor("pan");
				} else {
					(native.processor as GainNode).gain.value = 10 ** (numberFor("volumeDb") / 20);
				}
			}
		}
	}

	private _findAudioEngine(): AudioEngineV2 | null {
		for (const bus of this._buses) {
			for (const nodeId of bus.soundNodeIds) {
				const node = this._scene.getNodeById(nodeId) as any;
				if (node?.sound?.engine) {
					return node.sound.engine;
				}
			}
		}
		return typeof (this._scene as any).getEngine === "function" ? LastCreatedAudioEngine() : null;
	}

	private async _synchronizeNativeGraph(): Promise<void> {
		if (validateAudioMixerConfiguration(this._buses).length) {
			return;
		}
		const engine = this._findAudioEngine();
		if (!engine?.defaultMainBus) {
			return;
		}
		const topologyFingerprint = JSON.stringify(
			this._buses.map((bus) => [
				bus.id,
				bus.name,
				bus.parentBusId ?? null,
				(bus.sends ?? []).map((send) => [send.id, send.targetBusId, send.kind, send.enabled !== false]),
				(bus.effects ?? []).map((effect) => [effect.id, effect.type]),
			])
		);
		if (engine !== this._nativeEngine || topologyFingerprint !== this._nativeTopologyFingerprint) {
			this._disposeNativeBuses();
			this._nativeEngine = engine;
			const ordered = [...this._runtimeState.buses].sort((left, right) => left.depth - right.depth);
			for (const runtimeBus of ordered) {
				const definition = this._buses.find((bus) => bus.id === runtimeBus.id)!;
				const outBus: PrimaryAudioBus = (definition.parentBusId ? this._nativeBuses.get(definition.parentBusId) : null) ?? engine.defaultMainBus;
				const nativeBus = await engine.createBusAsync(definition.name, { outBus, volume: runtimeBus.audible ? definition.gain : 0 });
				this._nativeBuses.set(definition.id, nativeBus);
			}
			const webEngine = engine as AudioEngineV2 & { _audioContext?: AudioContext };
			if (webEngine._audioContext) {
				for (const bus of this._buses) {
					if (!(bus.effects ?? []).length) {
						continue;
					}
					const sourceBus = this._nativeBuses.get(bus.id) as (AudioBus & { _outNode?: AudioNode }) | undefined;
					const targetBus = (bus.parentBusId ? this._nativeBuses.get(bus.parentBusId) : engine.defaultMainBus) as (PrimaryAudioBus & { _inNode?: AudioNode }) | null;
					if (!sourceBus?._outNode || !targetBus?._inNode) {
						continue;
					}
					sourceBus._outNode.disconnect(targetBus._inNode);
					let previousNode: AudioNode = sourceBus._outNode;
					const nodes: AudioNode[] = [];
					const oscillators: OscillatorNode[] = [];
					let firstNode: AudioNode | null = null;
					for (const effect of bus.effects ?? []) {
						const nativeEffect = this._createNativeEffect(webEngine._audioContext, effect);
						previousNode.connect(nativeEffect.inputNode);
						firstNode ??= nativeEffect.inputNode;
						previousNode = nativeEffect.outputNode;
						nodes.push(...nativeEffect.nodes);
						if (nativeEffect.lfo) {
							oscillators.push(nativeEffect.lfo);
						}
						this._nativeEffects.set(effect.id, nativeEffect);
					}
					previousNode.connect(targetBus._inNode);
					this._nativeEffectChains.set(bus.id, {
						sourceNode: sourceBus._outNode,
						targetNode: targetBus._inNode,
						firstNode: firstNode!,
						lastNode: previousNode,
						nodes,
						oscillators,
					});
				}
			}
			for (const source of this._buses) {
				const sourceBus = this._nativeBuses.get(source.id) as (AudioBus & { _outNode?: AudioNode }) | undefined;
				if (!sourceBus?._outNode || !webEngine._audioContext) {
					continue;
				}
				for (const send of source.sends ?? []) {
					const targetBus = this._nativeBuses.get(send.targetBusId) as (AudioBus & { _inNode?: AudioNode }) | undefined;
					if (!targetBus?._inNode) {
						continue;
					}
					const gainNode = webEngine._audioContext.createGain();
					gainNode.gain.value = send.enabled === false ? 0 : send.gain;
					sourceBus._outNode.connect(gainNode);
					let analyserNode: AnalyserNode | null = null;
					if (send.kind === "return") {
						gainNode.connect(targetBus._inNode);
					} else {
						analyserNode = webEngine._audioContext.createAnalyser();
						analyserNode.fftSize = 256;
						analyserNode.smoothingTimeConstant = 0.5;
						gainNode.connect(analyserNode);
					}
					this._nativeSends.set(send.id, { gainNode, analyserNode });
				}
			}
			this._nativeTopologyFingerprint = topologyFingerprint;
		}
		const currentlyAssigned = new Set<string>();
		for (const bus of this._buses) {
			const nativeBus = this._nativeBuses.get(bus.id);
			if (!nativeBus) {
				continue;
			}
			for (const nodeId of bus.soundNodeIds) {
				const node = this._scene.getNodeById(nodeId) as any;
				if (!node?.sound || node.sound.engine !== engine) {
					continue;
				}
				node.sound.outBus = nativeBus;
				currentlyAssigned.add(nodeId);
			}
		}
		for (const nodeId of this._nativeAssignedSoundIds) {
			if (currentlyAssigned.has(nodeId)) {
				continue;
			}
			const node = this._scene.getNodeById(nodeId) as any;
			if (node?.sound?.engine === engine) {
				node.sound.outBus = engine.defaultMainBus;
			}
		}
		this._nativeAssignedSoundIds = currentlyAssigned;
		this._runtimeState = this._evaluateRuntime();
		this._applySoundValues();
		this._applyNativeBusValues();
		this._applyNativeEffectValues();
	}

	private _disposeNativeBuses(): void {
		for (const chain of this._nativeEffectChains.values()) {
			chain.sourceNode.disconnect(chain.firstNode);
			chain.lastNode.disconnect(chain.targetNode);
			for (const oscillator of chain.oscillators) {
				oscillator.stop();
			}
			for (const node of chain.nodes) {
				node.disconnect();
			}
			chain.sourceNode.connect(chain.targetNode);
		}
		this._nativeEffectChains.clear();
		this._nativeEffects.clear();
		for (const send of this._nativeSends.values()) {
			send.gainNode.disconnect();
			send.analyserNode?.disconnect();
		}
		this._nativeSends.clear();
		for (const bus of this._nativeBuses.values()) {
			bus.dispose();
		}
		this._nativeBuses.clear();
		this._nativeEngine = null;
		this._nativeTopologyFingerprint = "";
		this._nativeAssignedSoundIds.clear();
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		audioMixer?: AudioMixer;
	}
}

/** Returns the scene mixer, creating its shared runtime for editor preview or exported playback as needed. */
export function getOrCreateAudioMixer(scene: Scene, buses?: IAudioMixerBus[], snapshots?: IAudioMixerSnapshot[]): AudioMixer {
	scene.metadata ??= {};
	const definitions = buses ?? ((scene.metadata.babylonEditorAudioBuses ??= []) as IAudioMixerBus[]);
	const savedSnapshots = snapshots ?? ((scene.metadata.babylonEditorAudioMixerSnapshots ??= []) as IAudioMixerSnapshot[]);
	if (!scene.audioMixer) {
		scene.audioMixer = new AudioMixer(scene, definitions, savedSnapshots);
		scene.audioMixer.start();
	} else {
		scene.audioMixer.setConfiguration(definitions, savedSnapshots);
	}
	return scene.audioMixer;
}

export function configureAudioMixer(scene: Scene): void {
	getOrCreateAudioMixer(scene);
}
