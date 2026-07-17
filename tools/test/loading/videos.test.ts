import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveImportedVideoPath } from "../../src/loading/videos";

describe("video runtime import redirects", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("uses the portable imported output path from the build sidecar", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ outputPath: "assets/clip.webm" }) }))
		);
		await expect(resolveImportedVideoPath("/scene/", "assets/clip.mp4")).resolves.toBe("assets/clip.webm");
		expect(fetch).toHaveBeenCalledWith("/scene/assets/clip.mp4.bjsvideo.json");
	});

	test("falls back to the authored path when no sidecar is available", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false }))
		);
		await expect(resolveImportedVideoPath("/scene/", "assets/clip.mp4")).resolves.toBe("assets/clip.mp4");
	});
});
