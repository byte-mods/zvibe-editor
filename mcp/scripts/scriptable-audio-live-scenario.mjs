#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "server", "index.mjs");
if (!existsSync(serverPath)) {
	throw new Error("Bundled MCP server is missing; run the MCP bundle command first.");
}

const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let buffer = "";
let nextId = 1;
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) {
			const message = JSON.parse(line);
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		}
		newline = buffer.indexOf("\n");
	}
});

function rpc(method, params, timeoutMs = 60_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.[0]?.text ?? "";
	if (response.error || response.result?.isError) {
		throw new Error(`${name}: ${text || JSON.stringify(response.error)}`);
	}
	return JSON.parse(text);
}

async function expectFailure(name, args, pattern) {
	try {
		await call(name, args);
	} catch (error) {
		if (pattern.test(error.message)) {
			return;
		}
		throw error;
	}
	throw new Error(`${name} unexpectedly accepted an invalid request.`);
}

const unique = `${Date.now()}-${process.pid}`;
const path = `assets/__codex_audio_generator_${unique}.audio-generator.json`;
let fingerprint = null;
let nodeId = null;
let sourceBusId = null;
let returnBusId = null;
let sendId = null;
let effectId = null;
let zoneId = null;
let snapshotId = null;
let profileSettings = null;

try {
	await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scriptable-audio-live", version: "1.0.0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) {
		throw new Error("A running editor project is required.");
	}

	const types = await call("list_audio_generator_types");
	if (!types.types.some((type) => type.id === "oscillator") || types.limits.maximumNodes !== 128) {
		throw new Error("Audio Generator type discovery did not return the expected runtime contract.");
	}
	const created = await call("create_audio_generator", { path, name: `Live Generator ${unique}` });
	fingerprint = created.fingerprint;
	if (created.revision !== 1 || !created.buildReady || !/^[a-f0-9]{64}$/.test(fingerprint)) {
		throw new Error("Created generator did not publish exact revision/build evidence.");
	}
	const listed = await call("list_audio_generators", { query: unique });
	if (listed.totalCount !== 1 || listed.generators[0]?.path !== path) {
		throw new Error("Created generator was not discoverable through the registry.");
	}
	const soundAssets = await call("list_sound_assets");
	if (!soundAssets.assets.some((asset) => asset.path === path && asset.type === "audio-generator")) {
		throw new Error("Created generator was not discoverable as a SoundNode source.");
	}
	const inspected = await call("get_audio_generator", { path });
	const validation = await call("validate_audio_generator", { path });
	if (inspected.fingerprint !== fingerprint || !validation.valid || validation.fingerprint !== fingerprint) {
		throw new Error("Read/validate evidence did not match the created source lease.");
	}

	const updatedGraph = { ...inspected.graph, name: `${inspected.graph.name} Updated` };
	const updated = await call("set_audio_generator", { path, expectedFingerprint: fingerprint, graph: updatedGraph });
	if (updated.revision !== 2 || updated.graph.name !== updatedGraph.name || updated.fingerprint === fingerprint) {
		throw new Error("Exact graph update did not advance revision and source fingerprint.");
	}
	await expectFailure("set_audio_generator", { path, expectedFingerprint: fingerprint, graph: updatedGraph }, /changed|expectedFingerprint/i);
	fingerprint = updated.fingerprint;

	const sound = await call("create_sound", { path, name: `Live Generated Sound ${unique}`, spatial: false, volume: 0.1 });
	nodeId = sound.id;
	const soundState = await call("get_sound", { nodeId });
	if (soundState.path !== path || soundState.spatial !== false) {
		throw new Error("SoundNode did not load the generated-audio asset through the shared runtime.");
	}
	const tunedSound = await call("set_sound_properties", {
		nodeId,
		volume: 0.2,
		spatial: true,
		maxDistance: 1200,
		distanceModel: "inverse",
		panningModel: "HRTF",
		autoUpdateSpatial: true,
	});
	if (tunedSound.id !== nodeId) throw new Error("Sound properties did not update the generated SoundNode.");
	profileSettings = (await call("get_audio_mixer_profile", { includeSamples: false })).settings;
	await call("set_audio_mixer_profile", { enabled: true, sampleCapacity: 8, sampleEveryNUpdates: 1 });
	await call("clear_audio_mixer_profile");
	const sourceBus = await call("create_audio_bus", { name: `Live Source ${unique}`, gain: 0.8, pitch: 1, soundNodeIds: [] });
	sourceBusId = sourceBus.id;
	const returnBus = await call("create_audio_bus", { name: `Live Return ${unique}`, gain: 0.6, pitch: 1, soundNodeIds: [] });
	returnBusId = returnBus.id;
	const updatedBus = await call("set_audio_bus", { busId: sourceBusId, name: `Live Source Updated ${unique}`, gain: 0.75, pitch: 1.05 });
	if (updatedBus.gain !== 0.75 || updatedBus.pitch !== 1.05) throw new Error("Audio bus update did not round-trip.");
	const assigned = await call("assign_sound_node_to_audio_bus", { nodeId, busId: sourceBusId });
	if (assigned.busId !== sourceBusId) throw new Error("SoundNode bus assignment did not round-trip.");
	const send = await call("create_audio_send", { sourceBusId, name: `Live Return Send ${unique}`, targetBusId: returnBusId, kind: "return", gain: 0.5 });
	sendId = send.id;
	const updatedSend = await call("set_audio_send", { sourceBusId, sendId, name: `Live Return Send Updated ${unique}`, gain: 0.4, enabled: true });
	if (updatedSend.gain !== 0.4) throw new Error("Audio send update did not round-trip.");
	const effect = await call("create_audio_effect", {
		busId: returnBusId,
		name: `Live Reverb ${unique}`,
		type: "convolutionReverb",
		wet: 0.5,
		parameters: { decaySeconds: 1.5, preDelaySeconds: 0.02, dampingHz: 8000 },
	});
	effectId = effect.id;
	const updatedEffect = await call("set_audio_effect", { busId: returnBusId, effectId, name: `Live Reverb Updated ${unique}`, wet: 0.6, parameters: { decaySeconds: 2 } });
	if (updatedEffect.wet !== 0.6) throw new Error("Audio effect update did not round-trip.");
	const zone = await call("create_audio_reverb_zone", {
		name: `Live Reverb Zone ${unique}`,
		effectId,
		shape: "sphere",
		position: [0, 0, 0],
		innerRadius: 100,
		outerRadius: 500,
		blendDistance: 100,
		priority: 1,
	});
	zoneId = zone.id;
	const updatedZone = await call("set_audio_reverb_zone", { id: zoneId, name: `Live Reverb Zone Updated ${unique}`, outerRadius: 600, priority: 2 });
	if (updatedZone.outerRadius !== 600 || updatedZone.priority !== 2) throw new Error("Audio reverb-zone update did not round-trip.");
	const snapshot = await call("create_audio_mixer_snapshot", { name: `Live Mixer Snapshot ${unique}` });
	snapshotId = snapshot.id;
	const appliedSnapshot = await call("apply_audio_mixer_snapshot", { id: snapshotId, durationSeconds: 0, shape: "linear" });
	if (appliedSnapshot.appliedBusCount < 2) throw new Error("Audio mixer snapshot did not include the disposable buses.");
	await call("set_sound_playing", { nodeId, playing: true });
	await call("set_sound_playing", { nodeId, playing: false });
	await call("delete_audio_mixer_snapshot", { id: snapshotId });
	snapshotId = null;
	await call("delete_audio_reverb_zone", { id: zoneId });
	zoneId = null;
	await call("delete_audio_effect", { busId: returnBusId, effectId });
	effectId = null;
	await call("delete_audio_send", { sourceBusId, sendId });
	sendId = null;
	await call("assign_sound_node_to_audio_bus", { nodeId, busId: null });
	await call("delete_audio_bus", { busId: sourceBusId });
	sourceBusId = null;
	await call("delete_audio_bus", { busId: returnBusId });
	returnBusId = null;
	await call("clear_audio_mixer_profile");
	await call("set_audio_mixer_profile", profileSettings);
	profileSettings = null;
	await call("delete_node", { nodeId });
	nodeId = null;

	const deleted = await call("delete_audio_generator", { path, expectedFingerprint: fingerprint });
	fingerprint = null;
	if (!deleted.deleted || deleted.revision !== 2) {
		throw new Error("Exact graph deletion did not return the expected evidence.");
	}
	const after = await call("list_audio_generators", { query: unique });
	if (after.totalCount !== 0) {
		throw new Error("Deleted generator remains indexed.");
	}
	console.log(`[scriptable-audio-live] PASS — ${status.projectPath}`);
} finally {
	if (snapshotId) await call("delete_audio_mixer_snapshot", { id: snapshotId }).catch(() => undefined);
	if (zoneId) await call("delete_audio_reverb_zone", { id: zoneId }).catch(() => undefined);
	if (effectId && returnBusId) await call("delete_audio_effect", { busId: returnBusId, effectId }).catch(() => undefined);
	if (sendId && sourceBusId) await call("delete_audio_send", { sourceBusId, sendId }).catch(() => undefined);
	if (nodeId) await call("assign_sound_node_to_audio_bus", { nodeId, busId: null }).catch(() => undefined);
	if (sourceBusId) await call("delete_audio_bus", { busId: sourceBusId }).catch(() => undefined);
	if (returnBusId) await call("delete_audio_bus", { busId: returnBusId }).catch(() => undefined);
	if (profileSettings) await call("set_audio_mixer_profile", profileSettings).catch(() => undefined);
	if (nodeId) {
		await call("delete_node", { nodeId }).catch(() => undefined);
	}
	if (fingerprint) {
		await call("delete_audio_generator", { path, expectedFingerprint: fingerprint }).catch(() => undefined);
	}
	child.kill();
}
