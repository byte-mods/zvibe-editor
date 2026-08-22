import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

export interface ICameraNoiseLayer {
	amplitude: number;
	frequency: number;
	nonRandom?: boolean;
	phase?: number;
}

export interface ICameraNoiseTransformChannels {
	x: ICameraNoiseLayer[];
	y: ICameraNoiseLayer[];
	z: ICameraNoiseLayer[];
}

export interface ICameraNoiseProfile {
	id: string;
	name: string;
	position: ICameraNoiseTransformChannels;
	rotation: ICameraNoiseTransformChannels;
}

export interface ICameraNoiseSample {
	position: Vector3;
	rotationRadians: Vector3;
	pivotPosition: Vector3;
}

const axes = ["x", "y", "z"] as const;

function hash(seed: number, value: number): number {
	let state = (seed ^ Math.imul(value, 0x45d9f3b)) | 0;
	state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
	state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
	return ((state ^ (state >>> 16)) >>> 0) / 0xffffffff;
}

function smoothNoise(value: number, seed: number): number {
	const before = Math.floor(value);
	const amount = value - before;
	const fade = amount * amount * amount * (amount * (amount * 6 - 15) + 10);
	return ((hash(seed, before) * 2 - 1) * (1 - fade) + (hash(seed, before + 1) * 2 - 1) * fade) * 1.35;
}

function sampleLayers(layers: ICameraNoiseLayer[], elapsedSeconds: number, seed: number, amplitudeGain: number, frequencyGain: number): number {
	let result = 0;
	for (let index = 0; index < layers.length; index++) {
		const layer = layers[index];
		const phase = layer.phase ?? 0;
		const time = elapsedSeconds * layer.frequency * frequencyGain + phase;
		const signal = layer.nonRandom ? Math.sin(time * Math.PI * 2) : smoothNoise(time, seed + index * 104729);
		result += signal * layer.amplitude * amplitudeGain;
	}
	return result;
}

function sampleChannels(channels: ICameraNoiseTransformChannels, elapsedSeconds: number, seed: number, amplitudeGain: number, frequencyGain: number): Vector3 {
	return new Vector3(
		sampleLayers(channels.x, elapsedSeconds, seed + 17, amplitudeGain, frequencyGain),
		sampleLayers(channels.y, elapsedSeconds, seed + 31, amplitudeGain, frequencyGain),
		sampleLayers(channels.z, elapsedSeconds, seed + 47, amplitudeGain, frequencyGain)
	);
}

export function validateCameraNoiseProfile(profile: ICameraNoiseProfile): void {
	if (!profile.id?.trim() || !profile.name?.trim()) {
		throw new Error("Camera noise profiles require non-empty id and name values.");
	}
	let layerCount = 0;
	for (const [channelName, channels] of [
		["position", profile.position],
		["rotation", profile.rotation],
	] as const) {
		if (!channels || typeof channels !== "object") {
			throw new Error(`Camera noise ${channelName} channels are required.`);
		}
		for (const axis of axes) {
			const layers = channels[axis];
			if (!Array.isArray(layers)) {
				throw new Error(`Camera noise ${channelName}.${axis} must be an array.`);
			}
			if (layers.length > 8) {
				throw new Error(`Camera noise ${channelName}.${axis} supports at most 8 layers.`);
			}
			for (const layer of layers) {
				layerCount++;
				if (!Number.isFinite(layer.amplitude) || Math.abs(layer.amplitude) > 100000) {
					throw new Error("Camera noise amplitudes must be finite and within -100000..100000.");
				}
				if (!Number.isFinite(layer.frequency) || layer.frequency <= 0 || layer.frequency > 120) {
					throw new Error("Camera noise frequencies must be within 0..120 Hz.");
				}
				if (layer.phase !== undefined && (!Number.isFinite(layer.phase) || Math.abs(layer.phase) > 100000)) {
					throw new Error("Camera noise phases must be finite and bounded.");
				}
			}
		}
	}
	if (!layerCount) {
		throw new Error("Camera noise profiles require at least one position or rotation layer.");
	}
}

/** Evaluates deterministic layered positional-centimeter and rotational-degree noise without mutating scene state. */
export function evaluateCameraNoiseProfile(
	profile: ICameraNoiseProfile,
	elapsedSeconds: number,
	seed: number,
	amplitudeGain = 1,
	frequencyGain = 1,
	pivotOffset = Vector3.Zero()
): ICameraNoiseSample {
	const position = sampleChannels(profile.position, elapsedSeconds, seed, amplitudeGain, frequencyGain);
	const rotationDegrees = sampleChannels(profile.rotation, elapsedSeconds, seed + 65537, amplitudeGain, frequencyGain);
	const rotationRadians = rotationDegrees.scale(Math.PI / 180);
	const rotation = Quaternion.FromEulerAngles(rotationRadians.x, rotationRadians.y, rotationRadians.z);
	const rotatedPivot = Vector3.Zero();
	pivotOffset.rotateByQuaternionToRef(rotation, rotatedPivot);
	return { position, rotationRadians, pivotPosition: pivotOffset.subtract(rotatedPivot) };
}

export function emptyCameraNoiseChannels(): ICameraNoiseTransformChannels {
	return { x: [], y: [], z: [] };
}
