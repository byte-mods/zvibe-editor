import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, pathExists, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import sharp from "sharp";

import { processAssetFile } from "../../src/project/export/assets";
import { projectConfiguration } from "../../src/project/configuration";
import { readAssetMetadata, refreshAssetRegistryPaths, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { Animation, Vector3 } from "babylonjs";

function makeWav(): Buffer {
	const sampleRate = 48000;
	const frames = 4800;
	const data = Buffer.alloc(frames * 4);
	for (let frame = 0; frame < frames; frame++) {
		const sample = Math.round(Math.sin((frame / sampleRate) * Math.PI * 880) * 10000);
		data.writeInt16LE(sample, frame * 4);
		data.writeInt16LE(sample, frame * 4 + 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(2, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 4, 28);
	header.writeUInt16LE(4, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

function createVideo(path: string): void {
	const command = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const result = spawnSync(command, ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "0.3", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", path], {
		encoding: "utf-8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
}

const mediaToolsAvailable =
	spawnSync(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
	spawnSync(process.platform === "win32" ? "ffprobe.exe" : "ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

function triangleGltf(): Record<string, unknown> {
	const binary = Buffer.alloc(66);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4));
	[0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
	[0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 60 + index * 2));
	return {
		asset: { version: "2.0" },
		buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
			{ buffer: 0, byteOffset: 36, byteLength: 24, target: 34962 },
			{ buffer: 0, byteOffset: 60, byteLength: 6, target: 34963 },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
			{ bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
			{ bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
		],
		meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
		nodes: [{ mesh: 0 }],
		scenes: [{ nodes: [0] }],
		scene: 0,
	};
}

function triangleDae(): string {
	return `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
	<asset><up_axis>Y_UP</up_axis></asset>
	<library_geometries><geometry id="g"><mesh>
		<source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
		<vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles>
	</mesh></geometry></library_geometries>
	<library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes>
	<scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`;
}

describe("build-aware asset importers", () => {
	let root: string;
	let previousProjectPath: string | null;
	let source: string;
	let output: string;
	const editor = { layout: { console: { error: vi.fn(), progress: vi.fn() } } } as any;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "babylon-export-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(root, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(root, "assets"));
		await mkdir(join(root, "build"));
		source = join(root, "assets", "large.png");
		output = join(root, "build", "assets", "large.png");
		await writeFile(
			source,
			await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff0000" } })
				.png()
				.toBuffer()
		);
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(root);
	});

	test("resizes texture build output and invalidates cache when importer settings change", async () => {
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings.maxSize = 32;
		metadata.importer.settings.resizeAlgorithm = "nearest";
		await writeAssetMetadata(source, metadata);
		const cache: Record<string, string> = {};
		await processAssetFile(editor, source, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await sharp(output).metadata()).toMatchObject({ width: 32, height: 16 });
		const firstCache = cache["assets/large.png"];
		metadata.importer.settings.maxSize = 64;
		await writeAssetMetadata(source, metadata);
		await processAssetFile(editor, source, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await sharp(output).metadata()).toMatchObject({ width: 64, height: 32 });
		expect(cache["assets/large.png"]).not.toBe(firstCache);
	});

	test("excludes assets from build output and never exports sidecar metadata", async () => {
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings.includeInBuild = false;
		await writeAssetMetadata(source, metadata);
		await mkdir(join(root, "build", "assets"));
		await writeFile(output, "old output");
		const exportedAssets: string[] = [];
		await processAssetFile(editor, source, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache: {} });
		expect(await pathExists(output)).toBe(false);
		await processAssetFile(editor, `${source}.bjsmeta.json`, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache: {} });
		expect(exportedAssets).toEqual([]);
		expect(await readFile(`${source}.bjsmeta.json`, "utf-8")).toContain('"includeInBuild": false');
	});

	test.runIf(mediaToolsAvailable)("executes audio settings into build output and emits runtime load metadata", async () => {
		const audioSource = join(root, "assets", "tone.wav");
		const audioOutput = join(root, "build", "assets", "tone.wav");
		await writeFile(audioSource, makeWav());
		const metadata = await readAssetMetadata(audioSource);
		metadata.importer.settings = { ...metadata.importer.settings, loadType: "streaming", compressionFormat: "browser", sampleRate: "22050", forceMono: true };
		await writeAssetMetadata(audioSource, metadata);
		const exportedAssets: string[] = [];
		await processAssetFile(editor, audioSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache: {} });
		expect(await pathExists(audioOutput)).toBe(true);
		const runtimeMetadata = JSON.parse(await readFile(`${audioOutput}.bjsaudio.json`, "utf-8"));
		expect(runtimeMetadata).toMatchObject({
			version: 1,
			loadType: "streaming",
			result: {
				sourcePath: "assets/tone.wav",
				outputPath: "assets/tone.wav",
				transcoded: true,
				output: { sampleRate: 22050, channels: 1 },
			},
		});
		expect(JSON.stringify(runtimeMetadata)).not.toContain(root);
		expect(exportedAssets).toEqual([audioOutput, `${audioOutput}.bjsaudio.json`]);
	});

	test.runIf(mediaToolsAvailable)("executes video settings into a portable runtime artifact and redirect sidecar", async () => {
		const videoSource = join(root, "assets", "clip.mp4");
		const videoOutput = join(root, "build", "assets", "clip.webm");
		const runtimePath = join(root, "build", "assets", "clip.mp4.bjsvideo.json");
		createVideo(videoSource);
		const metadata = await readAssetMetadata(videoSource);
		metadata.importer.settings = { ...metadata.importer.settings, transcode: "webm", quality: 0.7, maxWidth: 320, maxHeight: 180, includeAudio: false };
		await writeAssetMetadata(videoSource, metadata);
		const exportedAssets: string[] = [];
		await processAssetFile(editor, videoSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache: {} });
		expect(await pathExists(videoOutput)).toBe(true);
		const runtimeMetadata = JSON.parse(await readFile(runtimePath, "utf-8"));
		expect(runtimeMetadata).toMatchObject({
			version: 1,
			outputPath: "assets/clip.webm",
			result: {
				sourcePath: "assets/clip.mp4",
				outputPath: "assets/clip.webm",
				transcoded: true,
				output: { width: 320, height: 180, videoCodec: "vp9", audioCodec: null },
			},
		});
		expect(JSON.stringify(runtimeMetadata)).not.toContain(root);
		expect(exportedAssets).toEqual([videoOutput, runtimePath]);
	});

	test("executes MSDF font settings into portable atlas, metrics, and redirect artifacts", async () => {
		const fontSource = join(root, "assets", "game.ttf");
		const fontOutput = join(root, "build", "assets", "game.ttf");
		const manifestPath = join(root, "build", "assets", "game.font.json");
		const atlasPath = join(root, "build", "assets", "game.font-0.png");
		const runtimePath = `${fontOutput}.bjsfont.json`;
		await copyFile(join(import.meta.dirname, "../../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontSource);
		const metadata = await readAssetMetadata(fontSource);
		metadata.importer.settings = {
			...metadata.importer.settings,
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "Build 361",
			fontSize: 48,
			padding: 4,
			distanceRange: 6,
		};
		await writeAssetMetadata(fontSource, metadata);
		const exportedAssets: string[] = [];
		const cache: Record<string, string> = {};
		await processAssetFile(editor, fontSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache });
		expect(await pathExists(fontOutput)).toBe(false);
		expect(await pathExists(manifestPath)).toBe(true);
		expect(await pathExists(atlasPath)).toBe(true);
		const runtimeMetadata = JSON.parse(await readFile(runtimePath, "utf-8"));
		expect(runtimeMetadata).toMatchObject({
			version: 1,
			renderMode: "msdf",
			manifestPath: "assets/game.font.json",
			dynamicFontPath: null,
			result: {
				sourcePath: "assets/game.ttf",
				outputDirectory: "assets",
				manifestPath: "assets/game.font.json",
				pages: [expect.objectContaining({ path: "assets/game.font-0.png" })],
			},
		});
		expect(JSON.stringify(runtimeMetadata)).not.toContain(root);
		expect(exportedAssets).toEqual([manifestPath, atlasPath, runtimePath]);

		const firstManifest = await readFile(manifestPath, "utf-8");
		await processAssetFile(editor, fontSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await readFile(manifestPath, "utf-8")).toBe(firstManifest);

		await remove(atlasPath);
		await processAssetFile(editor, fontSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await pathExists(atlasPath)).toBe(true);

		metadata.importer.settings.includeInBuild = false;
		await writeAssetMetadata(fontSource, metadata);
		await processAssetFile(editor, fontSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await pathExists(manifestPath)).toBe(false);
		expect(await pathExists(atlasPath)).toBe(false);
		expect(await pathExists(runtimePath)).toBe(false);
	});

	test("executes material validation and embedded extraction even when optimization is disabled", async () => {
		const materialSource = join(root, "assets", "surface.material");
		const materialOutput = join(root, "build", "assets", "surface.material");
		const runtimePath = `${materialOutput}.bjsmaterial.json`;
		const embedded = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKVQAAAABJRU5ErkJggg==";
		await writeFile(
			materialSource,
			JSON.stringify({
				customType: "BABYLON.PBRMaterial",
				albedoTexture: { name: embedded, url: embedded, coordinatesMode: 0 },
			})
		);
		const exportedAssets: string[] = [];
		const cache: Record<string, string> = {};
		await processAssetFile(editor, materialSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache });
		const runtime = JSON.parse(await readFile(runtimePath, "utf-8"));
		expect(runtime).toMatchObject({
			version: 1,
			sourceKind: "babylon-material",
			valid: true,
			result: {
				sourcePath: "assets/surface.material",
				outputPath: "assets/surface.material",
				extractedTextures: [expect.stringMatching(/^assets\/editor-generated_extracted-textures\/[a-f0-9]{64}\.png$/)],
			},
		});
		expect(JSON.stringify(runtime)).not.toContain(root);
		const extractedPath = join(root, "build", runtime.result.extractedTextures[0]);
		expect(await pathExists(extractedPath)).toBe(true);
		expect(await readFile(materialOutput, "utf-8")).not.toContain("data:image");
		expect(exportedAssets).toEqual([extractedPath, materialOutput, runtimePath]);

		const cachedAssets: string[] = [];
		await processAssetFile(editor, materialSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: cachedAssets, cache });
		expect(cachedAssets).toEqual([extractedPath, materialOutput, runtimePath]);

		await remove(extractedPath);
		const repairedAssets: string[] = [];
		await processAssetFile(editor, materialSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: repairedAssets, cache });
		expect(await pathExists(extractedPath)).toBe(true);
		expect(repairedAssets).toEqual([extractedPath, materialOutput, runtimePath]);
	});

	test("includes and validates Wavefront MTL assets in build output", async () => {
		const mtlSource = join(root, "assets", "body.mtl");
		const mtlOutput = join(root, "build", "assets", "body.mtl");
		await writeFile(mtlSource, "newmtl Body\nmap_Kd missing.png\n");
		const exportedAssets: string[] = [];
		await processAssetFile(editor, mtlSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache: {} });
		expect(await readFile(mtlOutput, "utf-8")).toContain("map_Kd missing.png");
		const runtime = JSON.parse(await readFile(`${mtlOutput}.bjsmaterial.json`, "utf-8"));
		expect(runtime).toMatchObject({ sourceKind: "mtl", valid: false, result: { missingTextures: ["assets/missing.png"], compile: { attempted: false } } });
		expect(exportedAssets).toEqual([mtlOutput, `${mtlOutput}.bjsmaterial.json`]);
	});

	test("executes animation resampling, loop defaults, compression, and portable reporting during builds", async () => {
		const animationSource = join(root, "assets", "walk.animation");
		const animationOutput = join(root, "build", "assets", "walk.animation");
		const runtimePath = `${animationOutput}.bjsanimation.json`;
		const animation = new Animation("Root Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
		animation.setKeys([
			{ frame: 0, value: new Vector3(0, 0, 0) },
			{ frame: 15, value: new Vector3(0.5, 0, 0) },
			{ frame: 30, value: new Vector3(1, 0, 0) },
		]);
		await writeFile(
			animationSource,
			JSON.stringify({
				name: "Walk",
				from: 0,
				to: 30,
				targetedAnimations: [{ targetId: "Root", animation: animation.serialize() }],
			})
		);
		const metadata = await readAssetMetadata(animationSource);
		metadata.importer.settings = {
			...metadata.importer.settings,
			resampleRate: 24,
			compression: "none",
			loopByDefault: true,
			rootMotionNode: "Root",
		};
		await writeAssetMetadata(animationSource, metadata);
		const exportedAssets: string[] = [];
		const cache: Record<string, string> = {};
		await processAssetFile(editor, animationSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache });
		expect(await readFile(animationOutput, "utf-8")).not.toBe(await readFile(animationSource, "utf-8"));
		const runtime = JSON.parse(await readFile(runtimePath, "utf-8"));
		expect(runtime).toMatchObject({
			version: 1,
			sourceKind: "animation-group",
			valid: true,
			result: {
				sourcePath: "assets/walk.animation",
				outputPath: "assets/walk.animation",
				sourceKeyCount: 3,
				sampledKeyCount: 25,
				outputKeyCount: 25,
				rootMotion: { requestedNode: "Root", resolved: true },
				clips: [{ name: "Walk", from: 0, to: 24, loop: true }],
			},
		});
		expect(JSON.stringify(runtime)).not.toContain(root);
		expect(exportedAssets).toEqual([animationOutput, runtimePath]);

		const cachedAssets: string[] = [];
		await processAssetFile(editor, animationSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: cachedAssets, cache });
		expect(cachedAssets).toEqual([animationOutput, runtimePath]);
		await remove(runtimePath);
		await processAssetFile(editor, animationSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await pathExists(runtimePath)).toBe(true);
	});

	test("executes model settings into processed build output and repairs missing generated artifacts", async () => {
		const modelSource = join(root, "assets", "triangle.gltf");
		const modelOutput = join(root, "build", "assets", "triangle.gltf");
		const processedOutput = `${modelOutput}.bjsmodel.babylon`;
		const runtimePath = `${modelOutput}.bjsmodel.json`;
		const document = triangleGltf() as { buffers: Array<{ byteLength: number; uri: string }> };
		const bufferPath = join(root, "assets", "triangle.bin");
		const bytes = Buffer.from(document.buffers[0].uri.split(",")[1], "base64");
		document.buffers[0].uri = "triangle.bin";
		await writeFile(modelSource, JSON.stringify(document));
		await writeFile(bufferPath, bytes);
		await refreshAssetRegistryPaths([modelSource, bufferPath]);
		const metadata = await readAssetMetadata(modelSource);
		metadata.importer.settings = {
			...metadata.importer.settings,
			convertUnits: false,
			scaleFactor: 4,
			generateColliders: true,
			normals: "calculate",
			tangents: "calculate",
			meshCompression: "high",
		};
		await writeAssetMetadata(modelSource, metadata);
		const exportedAssets: string[] = [];
		const cache: Record<string, string> = {};
		await processAssetFile(editor, modelSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache });
		const runtime = JSON.parse(await readFile(runtimePath, "utf-8"));
		expect(runtime).toMatchObject({
			version: 1,
			outputPath: "assets/triangle.gltf.bjsmodel.babylon",
			supported: true,
			valid: true,
			result: { sourcePath: "assets/triangle.gltf", unitScale: 4, meshCount: 1, triangleCount: 1, colliderCount: 1, quantizedMeshCount: 1 },
		});
		expect(JSON.stringify(runtime)).not.toContain(root);
		expect(await pathExists(processedOutput)).toBe(true);
		expect(exportedAssets).toEqual([modelOutput, processedOutput, runtimePath]);
		const firstProcessedModel = await readFile(processedOutput, "utf-8");

		const changed = Buffer.from(bytes);
		changed.writeFloatLE(2, 12);
		await writeFile(bufferPath, changed);
		await refreshAssetRegistryPaths([bufferPath]);
		await processAssetFile(editor, modelSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await readFile(processedOutput, "utf-8")).not.toBe(firstProcessedModel);

		await remove(processedOutput);
		await processAssetFile(editor, modelSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets: [], cache });
		expect(await pathExists(processedOutput)).toBe(true);
	});

	test("converts DAE through Assimp during editor builds and publishes conversion evidence", async () => {
		const modelSource = join(root, "assets", "legacy.dae");
		const modelOutput = join(root, "build", "assets", "legacy.dae");
		const processedOutput = `${modelOutput}.bjsmodel.babylon`;
		const runtimePath = `${modelOutput}.bjsmodel.json`;
		await writeFile(modelSource, triangleDae());
		const exportedAssets: string[] = [];
		await processAssetFile(editor, modelSource, { optimize: false, scenePath: join(root, "build"), projectDir: root, exportedAssets, cache: {} });
		const runtime = JSON.parse(await readFile(runtimePath, "utf-8"));
		expect(runtime).toMatchObject({
			supported: true,
			valid: true,
			result: {
				sourcePath: "assets/legacy.dae",
				outputPath: "assets/legacy.dae.bjsmodel.babylon",
				sourceFormat: "dae",
				meshCount: 1,
				triangleCount: 1,
				legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
			},
		});
		expect(await pathExists(processedOutput)).toBe(true);
		expect(exportedAssets).toEqual([modelOutput, processedOutput, runtimePath]);
	});
});
