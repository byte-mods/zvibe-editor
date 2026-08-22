import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";
import { symlink } from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { getTextureChannelPreview, setTextureChannelPreview } from "../../src/mcp/assets/assets";
import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	getTextureChannelPreviewState,
	clearTextureChannelPreviewStates,
	moveTextureChannelPreviewStates,
	onTextureChannelPreviewStateChangedObservable,
	resetTextureChannelPreviewStatesForTests,
	setTextureChannelPreviewState,
	transformTextureChannelPreviewPixels,
} from "../../src/mcp/assets/texture-channel-preview";
import { projectConfiguration } from "../../src/project/configuration";

describe("Texture Inspector channel preview", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		resetTextureChannelPreviewStatesForTests();
		directory = await mkdtemp(join(tmpdir(), "babylon-texture-channel-preview-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		await writeFile(join(directory, "assets", "channels.png"), Buffer.from([137, 80, 78, 71]));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		resetTextureChannelPreviewStatesForTests();
		await remove(directory);
	});

	test("defaults every asset to original RGBA with grayscale selected for single-channel previews", () => {
		expect(getTextureChannelPreviewState(join(directory, "assets", "channels.png"))).toEqual({ channel: "rgba", displayMode: "grayscale", revision: 0 });
	});

	test("renders exact grayscale and colorized R/G/B channels while keeping previews opaque", () => {
		const pixels = new Uint8Array([10, 20, 30, 40, 200, 150, 100, 50]);
		expect([...transformTextureChannelPreviewPixels(pixels, "red", "grayscale")]).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
		expect([...transformTextureChannelPreviewPixels(pixels, "red", "colorized")]).toEqual([10, 0, 0, 255, 200, 0, 0, 255]);
		expect([...transformTextureChannelPreviewPixels(pixels, "green", "colorized")]).toEqual([0, 20, 0, 255, 0, 150, 0, 255]);
		expect([...transformTextureChannelPreviewPixels(pixels, "blue", "colorized")]).toEqual([0, 0, 30, 255, 0, 0, 100, 255]);
	});

	test("shows alpha as opaque grayscale in both display modes and preserves RGBA bytes", () => {
		const pixels = new Uint8Array([10, 20, 30, 40]);
		expect([...transformTextureChannelPreviewPixels(pixels, "alpha", "grayscale")]).toEqual([40, 40, 40, 255]);
		expect([...transformTextureChannelPreviewPixels(pixels, "alpha", "colorized")]).toEqual([40, 40, 40, 255]);
		expect([...transformTextureChannelPreviewPixels(pixels, "rgba", "colorized")]).toEqual([...pixels]);
	});

	test("rejects malformed pixel buffers and unsupported runtime enum values", () => {
		expect(() => transformTextureChannelPreviewPixels(new Uint8Array([1, 2, 3]), "red", "grayscale")).toThrow("tightly packed RGBA8");
		expect(() => transformTextureChannelPreviewPixels(new Uint8Array(4), "cyan" as any, "grayscale")).toThrow("channel must be one of");
		expect(() => transformTextureChannelPreviewPixels(new Uint8Array(4), "red", "heatmap" as any)).toThrow("displayMode must be one of");
	});

	test("increments exact revisions, emits changes, and keeps identical writes idempotent", () => {
		const path = join(directory, "assets", "channels.png");
		const changes: any[] = [];
		const observer = onTextureChannelPreviewStateChangedObservable.add((change) => changes.push(change));
		const first = setTextureChannelPreviewState(path, { channel: "green", displayMode: "colorized" }, 0);
		expect(first).toMatchObject({ updated: true, state: { channel: "green", displayMode: "colorized", revision: 1 } });
		expect(setTextureChannelPreviewState(path, { channel: "green" }, 1)).toMatchObject({ updated: false, state: { revision: 1 } });
		expect(changes).toHaveLength(1);
		onTextureChannelPreviewStateChangedObservable.remove(observer);
	});

	test("rejects stale revisions and empty or invalid direct mutations", () => {
		const path = join(directory, "assets", "channels.png");
		setTextureChannelPreviewState(path, { channel: "blue" }, 0);
		expect(() => setTextureChannelPreviewState(path, { channel: "red" }, 0)).toThrow("current revision 1");
		expect(() => setTextureChannelPreviewState(path, {}, 1)).toThrow("Set at least one");
		expect(() => setTextureChannelPreviewState(path, { channel: "cyan" as any }, 1)).toThrow("channel must be one of");
		expect(() => setTextureChannelPreviewState(path, { displayMode: "heatmap" as any }, 1)).toThrow("displayMode must be one of");
	});

	test("keeps state isolated by normalized absolute asset path", () => {
		const first = join(directory, "assets", "channels.png");
		const second = join(directory, "assets", "other.png");
		setTextureChannelPreviewState(first, { channel: "alpha" }, 0);
		expect(getTextureChannelPreviewState(first)).toMatchObject({ channel: "alpha", revision: 1 });
		expect(getTextureChannelPreviewState(second)).toEqual({ channel: "rgba", displayMode: "grayscale", revision: 0 });
		expect(moveTextureChannelPreviewStates(first, second)).toBe(1);
		expect(getTextureChannelPreviewState(first)).toEqual({ channel: "rgba", displayMode: "grayscale", revision: 0 });
		expect(getTextureChannelPreviewState(second)).toMatchObject({ channel: "alpha", revision: 1 });
		expect(clearTextureChannelPreviewStates(join(directory, "assets"), true)).toBe(1);
		expect(getTextureChannelPreviewState(second)).toEqual({ channel: "rgba", displayMode: "grayscale", revision: 0 });
	});

	test("exposes bounded, non-persisted MCP evidence and exact-revision mutation", async () => {
		expect(MCPEndpoints.get_texture_channel_preview).toBeTypeOf("function");
		expect(MCPEndpoints.set_texture_channel_preview).toBeTypeOf("function");
		expect(
			getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: projectConfiguration.path, enableExperimentalFeatures: false } } } as any).features
				.textureInspectorChannelPreview
		).toBe(true);
		const before = await getTextureChannelPreview(null as any, { path: "assets/channels.png" });
		expect(before).toMatchObject({
			path: "assets/channels.png",
			channel: "rgba",
			displayMode: "grayscale",
			effectiveDisplayMode: "original",
			revision: 0,
			maximumPreviewDimension: 1024,
			persisted: false,
			mutatesAsset: false,
		});
		const after = await setTextureChannelPreview(null as any, {
			path: "assets/channels.png",
			expectedRevision: 0,
			channel: "red",
			displayMode: "colorized",
		});
		expect(after).toMatchObject({ updated: true, channel: "red", displayMode: "colorized", effectiveDisplayMode: "colorized", revision: 1 });
		await expect(setTextureChannelPreview(null as any, { path: "assets/channels.png", expectedRevision: 0, channel: "blue" })).rejects.toThrow("current revision 1");
	});

	test("reports alpha's effective grayscale behavior through MCP", async () => {
		await setTextureChannelPreview(null as any, { path: "assets/channels.png", expectedRevision: 0, channel: "alpha", displayMode: "colorized" });
		await expect(getTextureChannelPreview(null as any, { path: "assets/channels.png" })).resolves.toMatchObject({
			channel: "alpha",
			displayMode: "colorized",
			effectiveDisplayMode: "grayscale",
		});
	});

	test("rejects missing, unsupported, and project-escaping MCP paths", async () => {
		await expect(getTextureChannelPreview(null as any, { path: "assets/missing.png" })).rejects.toThrow("existing image file asset");
		await expect(getTextureChannelPreview(null as any, { path: "assets/not-a-texture.txt" })).rejects.toThrow("supported image asset");
		await expect(getTextureChannelPreview(null as any, { path: "../outside.png" })).rejects.toThrow("stay inside the open project");
		if (process.platform !== "win32") {
			const outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-texture-channel-preview-outside-"));
			try {
				const outsidePath = join(outsideDirectory, "outside.png");
				await writeFile(outsidePath, Buffer.from([137, 80, 78, 71]));
				await symlink(outsidePath, join(directory, "assets", "escaped.png"));
				await expect(getTextureChannelPreview(null as any, { path: "assets/escaped.png" })).rejects.toThrow("symbolic link");
			} finally {
				await remove(outsideDirectory);
			}
		}
	});
});
