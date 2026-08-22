#!/usr/bin/env node
const { tmpdir } = require("os");
const { join, resolve } = require("path");
const { rmSync } = require("fs");

const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");

const bundlePath = join(tmpdir(), `zvibe-cinematic-audio-${process.pid}.cjs`);
buildSync({
	entryPoints: [resolve(__dirname, "../../src/editor/layout/cinematic/v2/audio-capture.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	outfile: bundlePath,
	external: ["electron"],
});

app.whenReady().then(async () => {
	const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
	try {
		await window.loadURL("data:text/html,<title>Cinematic Audio Verification</title>");
		const result = await window.webContents.executeJavaScript(`
			(async () => {
				const { NullEngine, Scene, TransformNode } = require("babylonjs");
				const { createCinematicCapturePlan, createCinematicDocument, normalizeCinematicDocument } = require("babylonjs-editor-tools");
				const { renderCinematicOfflineAudio, encodeCinematicAudioWav } = require(${JSON.stringify(bundlePath)});
				const liveContext = new AudioContext({ sampleRate: 48000 });
				const sourceBuffer = liveContext.createBuffer(1, 48000, 48000);
				sourceBuffer.getChannelData(0).fill(0.25);
				const engine = new NullEngine();
				const scene = new Scene(engine);
				const voice = new TransformNode("Voice", scene);
				voice.id = "voice";
				voice.sound = { buffer: { _audioBuffer: sourceBuffer } };
				scene.metadata = {
					babylonEditorAudioBuses: [{
						id: "dialogue", name: "Dialogue", gain: 0.5, pitch: 1, muted: false, solo: false, parentBusId: null,
						soundNodeIds: ["voice"], sends: [],
						effects: [{ id: "gain", name: "Gain", type: "gain", enabled: true, wet: 1, parameters: { volumeDb: -6 } }],
					}],
					babylonEditorAudioMixerSnapshots: [],
				};
				const clip = {
					id: "voice-clip", name: "Voice", type: "audio", startFrame: 0, durationFrames: 30, clipInFrame: 0, timeScale: 1, enabled: true,
					blendInFrames: 0, blendOutFrames: 0, easeIn: "linear", easeOut: "linear", preExtrapolation: "none", postExtrapolation: "none",
					soundId: "voice", volume: 1, loop: false,
				};
				const document = normalizeCinematicDocument({
					...createCinematicDocument("Electron Audio", "electron-audio"), framesPerSecond: 30, durationMode: "fixed", durationFrames: 30,
					recorderProfiles: [{ id: "output", name: "Output", format: "webm", width: 16, height: 16, framesPerSecond: 30, quality: 1, includeAudio: true }],
					tracks: [{ id: "audio", name: "Audio", type: "audio", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#445566", clips: [clip], volumeKeys: [] }],
				});
				const rendered = await renderCinematicOfflineAudio(document, scene, createCinematicCapturePlan(document, "output"));
				const channel = rendered.buffer.getChannelData(0);
				let squareSum = 0;
				for (const value of channel) squareSum += value * value;
				const wav = encodeCinematicAudioWav(rendered.buffer);
				const evidence = {
					ready: rendered.inspection.ready,
					frames: rendered.buffer.length,
					sampleRate: rendered.buffer.sampleRate,
					channels: rendered.buffer.numberOfChannels,
					rms: Math.sqrt(squareSum / channel.length),
					wavBytes: wav.length,
					sources: rendered.inspection.sources.length,
					buses: rendered.inspection.mixer.busCount,
					effects: rendered.inspection.mixer.effectCount,
				};
				scene.dispose();
				engine.dispose();
				await liveContext.close();
				return evidence;
			})()
		`);
		if (
			!result.ready ||
			result.frames !== 48_000 ||
			result.sampleRate !== 48_000 ||
			result.channels !== 2 ||
			result.rms <= 0 ||
			result.sources !== 1 ||
			result.buses !== 1 ||
			result.effects !== 1
		) {
			throw new Error(`Unexpected offline-render evidence: ${JSON.stringify(result)}`);
		}
		console.log(`[cinematic-audio-electron] PASS — ${JSON.stringify(result)}`);
	} catch (error) {
		console.error(`[cinematic-audio-electron] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		process.exitCode = 1;
	} finally {
		window.destroy();
		rmSync(bundlePath, { force: true });
		app.quit();
	}
});
