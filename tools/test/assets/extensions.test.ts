import { describe, expect, it } from "vitest";

import {
	assetBuildSupportedExtensions,
	assetImageExtensions,
	assetModelExtensions,
	assetRootPlacementExclusions,
	assetRootRequiredExtensions,
	requiresAssetRoot,
} from "../../src/assets/extensions";

describe("asset extension contract", () => {
	it("publishes one unique 65-format build contract", () => {
		expect(assetBuildSupportedExtensions).toHaveLength(65);
		expect(new Set(assetBuildSupportedExtensions).size).toBe(assetBuildSupportedExtensions.length);
		expect(assetImageExtensions.every((extension) => assetBuildSupportedExtensions.includes(extension))).toBe(true);
		expect(assetModelExtensions.every((extension) => assetBuildSupportedExtensions.includes(extension))).toBe(true);
		expect(assetBuildSupportedExtensions).toEqual(
			expect.arrayContaining([".psd", ".svg", ".blend", ".abc", ".ase", ".aseprite", ".animator", ".npss", ".onnx", ".tflite", ".pt2"])
		);
	});

	it("requires assets placement for every unambiguous built format", () => {
		expect(assetRootPlacementExclusions).toEqual([".json"]);
		expect(assetRootRequiredExtensions).toHaveLength(64);
		expect(assetBuildSupportedExtensions.filter((extension) => !assetRootRequiredExtensions.includes(extension))).toEqual([".json"]);
		expect(requiresAssetRoot(" .PSD ")).toBe(true);
		expect(requiresAssetRoot(".json")).toBe(false);
		expect(requiresAssetRoot(".ts")).toBe(false);
	});
});
