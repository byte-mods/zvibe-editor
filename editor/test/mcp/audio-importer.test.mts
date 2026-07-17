import { spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, remove, stat, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { applyAudioImporterArtifact, getAudioImporterArtifactStatus, processAudioImporterOutput } from "../../src/mcp/assets/audio-importer";
import { projectConfiguration } from "../../src/project/configuration";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { normalizeAudioImporterSettings } from "babylonjs-editor-tools";
import { applyAudioImporter, getAudioImporterResult } from "../../src/mcp/assets/assets";
import { Scene } from "babylonjs";

function makeStereoWav(sampleRate = 48000, seconds = 0.1): Buffer {
	const frames = Math.round(sampleRate * seconds);
	const channels = 2;
	const data = Buffer.alloc(frames * channels * 2);
	for (let frame = 0; frame < frames; frame++) {
		const sample = Math.round(Math.sin((frame / sampleRate) * Math.PI * 2 * 440) * 12000);
		data.writeInt16LE(sample, frame * 4);
		data.writeInt16LE(sample / 2, frame * 4 + 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * channels * 2, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

const ffmpegAvailable = spawnSync(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const ffprobeAvailable = spawnSync(process.platform === "win32" ? "ffprobe.exe" : "ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

describe.runIf(ffmpegAvailable && ffprobeAvailable)("executed audio importer", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-audio-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("leases, transcodes, probes, publishes, and invalidates a mono resampled artifact", async () => {
		const path = join(directory, "assets", "tone.wav");
		await writeFile(path, makeStereoWav());
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = { ...metadata.importer.settings, loadType: "streaming", compressionFormat: "browser", sampleRate: "22050", forceMono: true, normalize: true };
		await writeAssetMetadata(path, metadata);

		const planned = await getAudioImporterArtifactStatus(path);
		expect(planned).toMatchObject({ current: false, exists: false });
		const applied = await applyAudioImporterArtifact(path, planned.fingerprint);
		expect(applied).toMatchObject({
			current: true,
			result: {
				transcoded: true,
				settings: { loadType: "streaming", sampleRate: "22050", forceMono: true, normalize: true },
				source: { sampleRate: 48000, channels: 2 },
				output: { sampleRate: 22050, channels: 1 },
			},
		});
		expect((await stat(applied.artifactPath)).size).toBeGreaterThan(44);
		expect((await getAudioImporterArtifactStatus(path)).current).toBe(true);

		await writeFile(path, makeStereoWav(44100));
		const stale = await getAudioImporterArtifactStatus(path);
		expect(stale).toMatchObject({ current: false, exists: true });
		await expect(applyAudioImporterArtifact(path, planned.fingerprint)).rejects.toThrow("plan changed");
	});

	test("uses the same preserve and runtime-load semantics for direct build output", async () => {
		const source = join(directory, "assets", "source.wav");
		const output = join(directory, "assets", "output.wav");
		await writeFile(source, makeStereoWav());
		const settings = normalizeAudioImporterSettings({
			loadType: "decompressOnLoad",
			compressionFormat: "preserve",
			quality: 0.8,
			sampleRate: "preserve",
			forceMono: false,
			normalize: false,
		});
		const result = await processAudioImporterOutput(source, output, settings);
		expect(result).toMatchObject({ transcoded: false, settings: { loadType: "decompressOnLoad" }, source: { channels: 2 }, output: { channels: 2 } });
		expect((await stat(output)).size).toBe((await stat(source)).size);
	});

	test("exposes leased audio import execution through the shared MCP action path", async () => {
		const path = join(directory, "assets", "mcp.wav");
		await writeFile(path, makeStereoWav());
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = { ...metadata.importer.settings, sampleRate: "44100", forceMono: true };
		await writeAssetMetadata(path, metadata);
		const scene = {} as Scene;
		const planned = await getAudioImporterResult(scene, { path: "assets/mcp.wav" });
		expect(planned).toMatchObject({ current: false, path: "assets/mcp.wav", artifactPath: expect.stringContaining(".bjseditor/imported-assets/") });
		await expect(applyAudioImporter(scene, { path: "assets/mcp.wav", expectedFingerprint: planned.fingerprint, confirm: false }, {} as any)).rejects.toThrow("confirm=true");
		const applied = await applyAudioImporter(scene, { path: "assets/mcp.wav", expectedFingerprint: planned.fingerprint, confirm: true }, { editor: { path: null } } as any);
		expect(applied).toMatchObject({ applied: true, current: true, result: { output: { sampleRate: 44100, channels: 1 } } });
	});
});
