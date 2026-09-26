#!/usr/bin/env node
/**
 * Synthesizes every sound used by Orb Rush (music loop + sound effects) as 16-bit mono WAV files.
 * Everything is generated from oscillators and noise in this file, so the audio is original and CC0.
 *
 * Usage: node tools/generate-audio.mjs [outputDirectory=assets/audio]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = process.argv[2] ?? "assets/audio";

// Deterministic noise so regenerating the audio always produces identical files.
let seed = 0x2f6e2b1;
function noise() {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return ((seed >>> 0) / 0xffffffff) * 2 - 1;
}

const TAU = Math.PI * 2;
const note = (midi) => 440 * 2 ** ((midi - 69) / 12);

const wave = {
	sine: (phase) => Math.sin(TAU * phase),
	triangle: (phase) => 1 - 4 * Math.abs(((phase + 0.25) % 1) - 0.5),
	square: (phase) => (phase % 1 < 0.5 ? 1 : -1),
	pulse: (phase) => (phase % 1 < 0.25 ? 1 : -1),
	saw: (phase) => 2 * (phase % 1) - 1,
};

/** Attack/decay/sustain/release envelope; returns 0 outside of [0, duration + release]. */
function adsr(t, duration, { attack = 0.005, decay = 0.05, sustain = 0.7, release = 0.05 } = {}) {
	if (t < 0) return 0;
	if (t < attack) return t / attack;
	if (t < attack + decay) return 1 - ((t - attack) / decay) * (1 - sustain);
	if (t < duration) return sustain;
	if (t < duration + release) return sustain * (1 - (t - duration) / release);
	return 0;
}

class Track {
	constructor(seconds, sampleRate, loop = false) {
		this.sampleRate = sampleRate;
		this.loop = loop;
		this.data = new Float32Array(Math.ceil(seconds * sampleRate));
	}

	/** Adds `render(t)` for `length` seconds starting at `start`; loop tracks wrap tails to the beginning for seamless looping. */
	add(start, length, render) {
		const first = Math.floor(start * this.sampleRate);
		const count = Math.ceil(length * this.sampleRate);
		for (let i = 0; i < count; i++) {
			let index = first + i;
			if (index >= this.data.length) {
				if (!this.loop) break;
				index %= this.data.length;
			}
			this.data[index] += render(i / this.sampleRate);
		}
	}

	/** Plays an oscillator note with optional pitch slide and vibrato. */
	tone(start, duration, frequency, { type = "square", volume = 0.3, to = frequency, vibrato = 0, env = {} } = {}) {
		let phase = 0;
		const release = env.release ?? 0.05;
		this.add(start, duration + release, (t) => {
			const progress = Math.min(1, t / duration);
			const f = frequency * (to / frequency) ** progress * (1 + vibrato * Math.sin(TAU * 6 * t));
			phase += f / this.sampleRate;
			return wave[type](phase) * adsr(t, duration, env) * volume;
		});
	}

	/** Filtered noise burst (one-pole low-pass with a decaying cutoff). */
	noiseBurst(start, duration, { volume = 0.3, cutoff = 4000, cutoffEnd = cutoff, decay = 8 } = {}) {
		let low = 0;
		this.add(start, duration, (t) => {
			const c = cutoff * (cutoffEnd / cutoff) ** (t / duration);
			const alpha = 1 - Math.exp((-TAU * c) / this.sampleRate);
			low += alpha * (noise() - low);
			return low * Math.exp(-decay * t) * volume;
		});
	}

	kick(start, volume = 0.9) {
		let phase = 0;
		this.add(start, 0.35, (t) => {
			phase += (45 + 110 * Math.exp(-t * 28)) / this.sampleRate;
			return Math.sin(TAU * phase) * Math.exp(-t * 9) * volume;
		});
	}

	snare(start, volume = 0.45) {
		this.noiseBurst(start, 0.22, { volume, cutoff: 7000, cutoffEnd: 2500, decay: 18 });
		this.tone(start, 0.08, 190, { type: "triangle", volume: volume * 0.6, to: 150, env: { decay: 0.06, sustain: 0.2, release: 0.04 } });
	}

	hat(start, volume = 0.12) {
		let previous = 0;
		this.add(start, 0.06, (t) => {
			const value = noise();
			const high = value - previous; // crude high-pass keeps only the fizz
			previous = value;
			return high * Math.exp(-t * 70) * volume;
		});
	}

	/** Normalizes to the given peak with a gentle soft clip and click-free fades on one-shot sounds. */
	master(peak = 0.89) {
		let max = 0;
		for (const value of this.data) max = Math.max(max, Math.abs(value));
		const gain = max > 0 ? peak / max : 1;
		const fadeIn = Math.floor(0.002 * this.sampleRate);
		const fadeOut = Math.floor(0.004 * this.sampleRate);
		for (let i = 0; i < this.data.length; i++) {
			let value = Math.tanh(this.data[i] * gain * 1.1) / Math.tanh(1.1);
			if (!this.loop && i < fadeIn) value *= i / fadeIn;
			if (!this.loop && i > this.data.length - fadeOut) value *= (this.data.length - i) / fadeOut;
			this.data[i] = value;
		}
		return this;
	}

	toWav() {
		const bytes = Buffer.alloc(44 + this.data.length * 2);
		bytes.write("RIFF", 0);
		bytes.writeUInt32LE(36 + this.data.length * 2, 4);
		bytes.write("WAVEfmt ", 8);
		bytes.writeUInt32LE(16, 16);
		bytes.writeUInt16LE(1, 20); // PCM
		bytes.writeUInt16LE(1, 22); // mono
		bytes.writeUInt32LE(this.sampleRate, 24);
		bytes.writeUInt32LE(this.sampleRate * 2, 28);
		bytes.writeUInt16LE(2, 32);
		bytes.writeUInt16LE(16, 34);
		bytes.write("data", 36);
		bytes.writeUInt32LE(this.data.length * 2, 40);
		this.data.forEach((value, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
		return bytes;
	}
}

const SFX_RATE = 44100;

function pickup() {
	const track = new Track(0.4, SFX_RATE);
	track.tone(0, 0.07, note(88), { volume: 0.35, env: { decay: 0.03, sustain: 0.6 } });
	track.tone(0.06, 0.2, note(95), { volume: 0.35, vibrato: 0.01, env: { decay: 0.1, sustain: 0.4, release: 0.1 } });
	track.tone(0.06, 0.2, note(83), { type: "triangle", volume: 0.25, env: { decay: 0.1, sustain: 0.4, release: 0.1 } });
	return track;
}

function jump() {
	const track = new Track(0.3, SFX_RATE);
	track.tone(0, 0.22, 260, { type: "pulse", volume: 0.3, to: 780, env: { decay: 0.15, sustain: 0.3, release: 0.06 } });
	return track;
}

function impact() {
	const track = new Track(0.35, SFX_RATE);
	track.tone(0, 0.18, 110, { type: "sine", volume: 0.8, to: 38, env: { attack: 0.002, decay: 0.15, sustain: 0.1, release: 0.1 } });
	track.noiseBurst(0, 0.2, { volume: 0.5, cutoff: 1800, cutoffEnd: 300, decay: 22 });
	return track;
}

function bump() {
	const track = new Track(0.5, SFX_RATE);
	for (const [frequency, detune] of [
		[220, 1],
		[331, 1.007],
		[497, 0.994],
	]) {
		track.tone(0, 0.3, frequency * detune, { type: "square", volume: 0.14, to: frequency * 0.8, env: { attack: 0.001, decay: 0.25, sustain: 0.1, release: 0.15 } });
	}
	track.noiseBurst(0, 0.12, { volume: 0.4, cutoff: 6000, cutoffEnd: 800, decay: 30 });
	return track;
}

function tick() {
	const track = new Track(0.08, SFX_RATE);
	track.tone(0, 0.02, 1320, { type: "square", volume: 0.25, env: { attack: 0.001, decay: 0.015, sustain: 0.1, release: 0.02 } });
	return track;
}

function start() {
	const track = new Track(0.8, SFX_RATE);
	track.noiseBurst(0, 0.6, { volume: 0.25, cutoff: 300, cutoffEnd: 6000, decay: 2 });
	[72, 76, 79, 84].forEach((midi, i) => track.tone(i * 0.08, 0.1, note(midi), { volume: 0.2, env: { decay: 0.05, sustain: 0.5, release: 0.08 } }));
	return track;
}

function win() {
	const track = new Track(1.8, SFX_RATE);
	[72, 76, 79, 84].forEach((midi, i) => track.tone(i * 0.11, 0.1, note(midi), { volume: 0.25, env: { decay: 0.05, sustain: 0.6, release: 0.06 } }));
	for (const midi of [72, 76, 79, 84]) {
		track.tone(0.5, 0.9, note(midi), { type: "triangle", volume: 0.2, vibrato: 0.004, env: { attack: 0.02, decay: 0.3, sustain: 0.6, release: 0.35 } });
	}
	track.tone(0.5, 0.9, note(96), { type: "square", volume: 0.08, vibrato: 0.006, env: { attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.35 } });
	return track;
}

function lose() {
	const track = new Track(1.6, SFX_RATE);
	[67, 64, 60].forEach((midi, i) => track.tone(i * 0.25, 0.22, note(midi), { type: "triangle", volume: 0.3, env: { decay: 0.1, sustain: 0.6, release: 0.08 } }));
	track.tone(0.75, 0.7, note(47), { type: "saw", volume: 0.18, to: note(40), vibrato: 0.01, env: { decay: 0.3, sustain: 0.6, release: 0.2 } });
	return track;
}

/** 8 bars at 120 BPM in A minor (Am–F–C–G), rendered as a seamless loop. */
function music() {
	const bpm = 120;
	const beat = 60 / bpm;
	const bars = 8;
	const track = new Track(bars * 4 * beat, 22050, true);
	const chords = [
		[57, 60, 64],
		[53, 57, 60],
		[48, 52, 55],
		[55, 59, 62],
	];
	const melody = [76, null, 74, 72, 74, null, 72, 69, 72, null, 71, 67, 69, null, null, null];

	for (let bar = 0; bar < bars; bar++) {
		const chord = chords[bar % 4];
		const barStart = bar * 4 * beat;

		// Drums: kick on 1 and 3 (plus a pickup on the last bar), snare on 2 and 4, hats on every eighth.
		track.kick(barStart);
		track.kick(barStart + 2 * beat);
		if (bar % 4 === 3) track.kick(barStart + 3.5 * beat, 0.6);
		track.snare(barStart + beat);
		track.snare(barStart + 3 * beat);
		for (let eighth = 0; eighth < 8; eighth++) track.hat(barStart + eighth * beat * 0.5, eighth % 2 ? 0.07 : 0.11);

		// Bass: driving root eighths with an octave bounce.
		for (let eighth = 0; eighth < 8; eighth++) {
			const midi = chord[0] - 24 + (eighth % 4 === 3 ? 12 : 0);
			track.tone(barStart + eighth * beat * 0.5, beat * 0.42, note(midi), { type: "pulse", volume: 0.2, env: { decay: 0.08, sustain: 0.5, release: 0.03 } });
		}

		// Arpeggio: sixteenth notes climbing through the chord.
		for (let sixteenth = 0; sixteenth < 16; sixteenth++) {
			const midi = chord[sixteenth % 3] + 12 * (Math.floor(sixteenth / 3) % 2);
			track.tone(barStart + sixteenth * beat * 0.25, beat * 0.2, note(midi), { type: "triangle", volume: 0.09, env: { decay: 0.05, sustain: 0.3, release: 0.03 } });
		}

		// Lead melody on the second half of the loop.
		if (bar >= 4) {
			const phrase = melody.slice(((bar - 4) % 2) * 8, ((bar - 4) % 2) * 8 + 8);
			phrase.forEach((midi, eighth) => {
				if (midi === null) return;
				const midiNote = bar >= 6 ? midi + (bar === 7 ? -2 : 0) : midi;
				track.tone(barStart + eighth * beat * 0.5, beat * 0.45, note(midiNote), {
					type: "square",
					volume: 0.1,
					vibrato: 0.004,
					env: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.08 },
				});
			});
		}
	}

	return track;
}

const sounds = { music, pickup, jump, impact, bump, tick, start, win, lose };
// Per-sound peak levels balance perceived loudness (dense pulse/square sounds are quieter at the same peak).
const peaks = { music: 0.8, jump: 0.55, tick: 0.6, pickup: 0.8 };

await mkdir(outputDirectory, { recursive: true });
for (const [name, create] of Object.entries(sounds)) {
	const track = create().master(peaks[name] ?? 0.89);
	const path = join(outputDirectory, `${name}.wav`);
	await writeFile(path, track.toWav());
	console.log(`${path} (${(track.data.length / track.sampleRate).toFixed(2)}s, ${track.sampleRate} Hz)`);
}
