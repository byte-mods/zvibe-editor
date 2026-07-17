import { spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, remove, stat, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { Scene } from "babylonjs";
import { normalizeVideoImporterSettings } from "babylonjs-editor-tools";

import { applyVideoImporterArtifact, getVideoImporterArtifactStatus, processVideoImporterOutput } from "../../src/mcp/assets/video-importer";
import { applyVideoImporter, getVideoImporterResult } from "../../src/mcp/assets/assets";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

const ffmpeg = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const mediaToolsAvailable = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0 && spawnSync(ffprobe, ["-version"], { stdio: "ignore" }).status === 0;

function createVideo(path: string): void {
	const result = spawnSync(
		ffmpeg,
		[
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=size=640x360:rate=30",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-t",
			"0.4",
			"-c:v",
			"mpeg4",
			"-c:a",
			"aac",
			"-pix_fmt",
			"yuv420p",
			path,
		],
		{ encoding: "utf-8" }
	);
	if (result.status !== 0) throw new Error(result.stderr);
}

describe.runIf(mediaToolsAvailable)("executed video importer", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-video-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("leases, resizes, removes audio, transcodes, and invalidates a WebM artifact", async () => {
		const path = join(directory, "assets", "clip.mp4");
		createVideo(path);
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = { ...metadata.importer.settings, transcode: "webm", quality: 0.65, maxWidth: 320, maxHeight: 180, includeAudio: false };
		await writeAssetMetadata(path, metadata);

		const planned = await getVideoImporterArtifactStatus(path);
		expect(planned).toMatchObject({ current: false, exists: false, artifactPath: expect.stringMatching(/clip\.webm$/) });
		const applied = await applyVideoImporterArtifact(path, planned.fingerprint);
		expect(applied).toMatchObject({
			current: true,
			result: {
				transcoded: true,
				settings: { transcode: "webm", maxWidth: 320, maxHeight: 180, includeAudio: false },
				source: { width: 640, height: 360, audioCodec: "aac" },
				output: { width: 320, height: 180, videoCodec: "vp9", audioCodec: null },
			},
		});
		expect((await stat(applied.artifactPath)).size).toBeGreaterThan(0);

		metadata.importer.settings.quality = 0.9;
		await writeAssetMetadata(path, metadata);
		expect(await getVideoImporterArtifactStatus(path)).toMatchObject({ current: false, exists: true });
		await expect(applyVideoImporterArtifact(path, planned.fingerprint)).rejects.toThrow("plan changed");
	});

	test("preserves a compatible source for direct build output", async () => {
		const source = join(directory, "assets", "source.mp4");
		const requestedOutput = join(directory, "assets", "output.mp4");
		createVideo(source);
		const result = await processVideoImporterOutput(
			source,
			requestedOutput,
			normalizeVideoImporterSettings({ transcode: "preserve", quality: 0.8, maxWidth: 1920, maxHeight: 1080, includeAudio: true })
		);
		expect(result).toMatchObject({ transcoded: false, outputPath: requestedOutput, source: { width: 640, height: 360 }, output: { audioCodec: "aac" } });
		expect((await stat(result.outputPath)).size).toBe((await stat(source)).size);
	});

	test("exposes leased video import execution through the shared MCP action path", async () => {
		const path = join(directory, "assets", "mcp.mp4");
		createVideo(path);
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = { ...metadata.importer.settings, maxWidth: 320, maxHeight: 180 };
		await writeAssetMetadata(path, metadata);
		const scene = {} as Scene;
		const planned = await getVideoImporterResult(scene, { path: "assets/mcp.mp4" });
		expect(planned).toMatchObject({ current: false, path: "assets/mcp.mp4", artifactPath: expect.stringContaining(".bjseditor/imported-assets/") });
		await expect(applyVideoImporter(scene, { path: "assets/mcp.mp4", expectedFingerprint: planned.fingerprint, confirm: false }, {} as any)).rejects.toThrow("confirm=true");
		const applied = await applyVideoImporter(scene, { path: "assets/mcp.mp4", expectedFingerprint: planned.fingerprint, confirm: true }, { editor: { path: null } } as any);
		expect(applied).toMatchObject({ applied: true, current: true, result: { output: { width: 320, height: 180 } } });
	});
});
