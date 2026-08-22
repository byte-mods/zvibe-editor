import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
	getAssetStreamingContentType,
	inferAssetStreamingPriority,
	openAssetStreamingFileRange,
	parseAssetStreamingByteRange,
	resolvePackagedAsset,
} from "../../../templates/electron/src/electron/asset-streaming.mts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Electron packaged asset streaming", () => {
	test("parses single ranges and assigns stable scene/geometry/media priorities", () => {
		expect(parseAssetStreamingByteRange(null, 10)).toEqual({ start: 0, end: 9, length: 10 });
		expect(parseAssetStreamingByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5, length: 4 });
		expect(parseAssetStreamingByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9, length: 3 });
		expect(parseAssetStreamingByteRange("bytes=20-", 10)).toBeNull();
		expect(parseAssetStreamingByteRange("bytes=1-2,4-5", 10)).toBeNull();
		expect(inferAssetStreamingPriority("scene/world.babylon", null)).toBe("critical");
		expect(inferAssetStreamingPriority("scene/mesh.bin", null)).toBe("high");
		expect(inferAssetStreamingPriority("scene/music.ogg", "background")).toBe("background");
		expect(getAssetStreamingContentType("scene/albedo.png")).toBe("image/png");
		expect(getAssetStreamingContentType("scene/data.unknown")).toBe("application/octet-stream");
	});

	test("resolves only regular project-contained files and streams a bounded range", async () => {
		const root = await mkdtemp(join(tmpdir(), "zvibe-electron-stream-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "scene"));
		const path = join(root, "scene", "sample.bin");
		await writeFile(path, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
		const asset = await resolvePackagedAsset(root, "zvibe-asset://local/scene/sample.bin");
		expect(asset).toMatchObject({ relativePath: "scene/sample.bin", sizeBytes: 10 });

		const range = parseAssetStreamingByteRange("bytes=2-7", asset.sizeBytes)!;
		const values: number[] = [];
		for await (const chunk of openAssetStreamingFileRange(asset.absolutePath, range, 2, new AbortController().signal)) values.push(...chunk);
		expect(values).toEqual([2, 3, 4, 5, 6, 7]);

		await symlink(path, join(root, "scene", "linked.bin"));
		await expect(resolvePackagedAsset(root, "zvibe-asset://local/scene/linked.bin")).rejects.toThrow("symbolic links");
		await expect(resolvePackagedAsset(root, "zvibe-asset://remote/scene/sample.bin")).rejects.toThrow("local packaged-asset authority");
		await expect(resolvePackagedAsset(root, "zvibe-asset://local/scene/%5Csample.bin")).rejects.toThrow("inside the packaged application");
	});

	test("propagates cancellation before a file range is consumed", async () => {
		const root = await mkdtemp(join(tmpdir(), "zvibe-electron-cancel-"));
		temporaryDirectories.push(root);
		const path = join(root, "sample.bin");
		await writeFile(path, Uint8Array.from([1, 2, 3]));
		const controller = new AbortController();
		controller.abort(new Error("test cancellation"));
		const stream = openAssetStreamingFileRange(path, { start: 0, end: 2, length: 3 }, 2, controller.signal);
		await expect(
			(async () => {
				for await (const _chunk of stream) void _chunk;
			})()
		).rejects.toThrow("test cancellation");
	});
});
