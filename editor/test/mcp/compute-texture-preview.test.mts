import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import sharp from "sharp";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph } from "babylonjs-editor-tools";

import { addCustomComputeNode, initializeCustomComputeNodeGraph } from "../../src/mcp/rendering/compute-graph";
import { getCustomComputeTextureNodePreviews } from "../../src/mcp/rendering/compute-texture-preview";
import { createCustomRenderPass, setCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/compute-texture-preview", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	let directory: string;
	let outsideDirectory: string;
	let previousPath: string | null;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		directory = await mkdtemp(join(tmpdir(), "babylon-compute-texture-preview-"));
		outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-compute-texture-outside-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 255, 255, 255, 255]);
		await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
			.png()
			.toFile(join(directory, "assets", "checker.png"));
		await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
			.png()
			.toFile(join(outsideDirectory, "outside.png"));
	});

	afterEach(async () => {
		disposeCustomRenderPassGraph(camera as any);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await rm(directory, { recursive: true, force: true });
		await rm(outsideDirectory, { recursive: true, force: true });
	});

	function pass(): any {
		const wgsl = `@group(0) @binding(0) var outputTexture : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var source : texture_2d<f32>;
@group(0) @binding(2) var missing : texture_2d<f32>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
	let size = textureDimensions(outputTexture);
	if (id.x >= size.x || id.y >= size.y) { return; }
	let value = textureLoad(source, vec2<i32>(0), 0) + textureLoad(missing, vec2<i32>(0), 0);
	textureStore(outputTexture, vec2<i32>(id.xy), value);
}`;
		const value = createCustomRenderPass(
			scene,
			{
				name: "Texture Thumbnails",
				passType: "compute",
				output: "textureThumbnailOutput",
				samplingMode: "nearest",
				inputs: {
					source: { source: "texture", path: "assets/checker.png", group: 0, binding: 1 },
					missing: { source: "texture", path: "assets/missing.png", group: 0, binding: 2 },
				},
				computeSettings: { wgsl },
			},
			options
		);
		initializeCustomComputeNodeGraph(scene, { id: value.id }, options);
		addCustomComputeNode(scene, { id: value.id, node: { id: "sourceNode", type: "texture-load", position: [200, 240], resourceName: "source" } }, options);
		addCustomComputeNode(scene, { id: value.id, node: { id: "missingNode", type: "texture-load", position: [200, 320], resourceName: "missing" } }, options);
		return value;
	}

	test("decodes and nearest-resamples bounded PNG thumbnails with deterministic pixel diagnostics", async () => {
		const value = pass();
		const result = await getCustomComputeTextureNodePreviews(scene, { id: value.id, width: 16, height: 16, sampling: "nearest" });
		expect(result).toMatchObject({ passId: value.id, requestedSize: [16, 16], sampling: "nearest", includeImage: true, readyCount: 1, unavailableCount: 1 });
		const ready = result.entries.find((entry: any) => entry.nodeId === "sourceNode");
		expect(ready).toMatchObject({
			status: "ready",
			source: { path: "assets/checker.png", width: 2, height: 2, format: "png" },
			thumbnail: {
				width: 16,
				height: 16,
				channels: 4,
				sampling: "nearest",
				mimeType: "image/png",
				pixelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				averageRgba: [0.5, 0.5, 0.25, 0.75],
				minimumRgba: [0, 0, 0, 0],
				maximumRgba: [1, 1, 1, 1],
				alphaCoverage: 0.75,
				imageBase64: expect.any(String),
			},
		});
		const decoded = await sharp(Buffer.from(ready.thumbnail.imageBase64, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(decoded.info).toMatchObject({ width: 16, height: 16, channels: 4 });
		expect([...decoded.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
		expect([...decoded.data.subarray((15 * 16 + 15) * 4, (15 * 16 + 15) * 4 + 4)]).toEqual([255, 255, 255, 255]);
		expect(result.entries.find((entry: any) => entry.nodeId === "missingNode")).toMatchObject({ status: "unavailable", error: expect.stringContaining("not found") });
	});

	test("supports metadata-only filtering and rejects oversized requests before decoding", async () => {
		const value = pass();
		const result = await getCustomComputeTextureNodePreviews(scene, { id: value.id, nodeIds: ["sourceNode"], width: 32, height: 16, includeImage: false });
		expect(result).toMatchObject({ includeImage: false, readyCount: 1, unavailableCount: 0, entries: [{ nodeId: "sourceNode", status: "ready" }] });
		expect(result.entries[0].thumbnail.imageBase64).toBeUndefined();
		await expect(getCustomComputeTextureNodePreviews(scene, { id: value.id, width: 129, height: 16 })).rejects.toThrow("16 through 128");
		setCustomRenderPass(
			scene,
			{
				id: value.id,
				inputs: {
					source: { source: "texture", path: "../outside.png", group: 0, binding: 1 },
					missing: { source: "texture", path: "assets/missing.png", group: 0, binding: 2 },
				},
			},
			options
		);
		const unsafe = await getCustomComputeTextureNodePreviews(scene, { id: value.id, nodeIds: ["sourceNode"] });
		expect(unsafe.entries).toEqual([expect.objectContaining({ nodeId: "sourceNode", status: "unavailable", error: expect.stringContaining("stay inside") })]);

		await symlink(join(outsideDirectory, "outside.png"), join(directory, "assets", "linked.png"));
		setCustomRenderPass(
			scene,
			{
				id: value.id,
				inputs: {
					source: { source: "texture", path: "assets/linked.png", group: 0, binding: 1 },
					missing: { source: "texture", path: "assets/missing.png", group: 0, binding: 2 },
				},
			},
			options
		);
		const linked = await getCustomComputeTextureNodePreviews(scene, { id: value.id, nodeIds: ["sourceNode"] });
		expect(linked.entries).toEqual([expect.objectContaining({ nodeId: "sourceNode", status: "unavailable", error: expect.stringContaining("resolve inside") })]);
	});
});
