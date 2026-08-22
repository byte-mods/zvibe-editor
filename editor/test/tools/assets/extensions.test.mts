import { describe, expect, it } from "vitest";

import { assetRootRequiredExtensions } from "babylonjs-editor-tools";

import {
	assetsAllSupportedExtensions,
	assetsAudioExtensions,
	assetsImageExtensions,
	assetsModelExtensions,
	assetsRetainedUIExtensions,
	assetsVideoExtensions,
} from "../../../src/tools/assets/extensions";

describe("Assets Browser extension aliases", () => {
	it("uses the exact shared root-placement contract", () => {
		expect(assetsAllSupportedExtensions).toBe(assetRootRequiredExtensions);
		expect(assetsAllSupportedExtensions).toHaveLength(64);
		expect(assetsAllSupportedExtensions).toEqual(
			expect.arrayContaining([".psd", ".svg", ".blend", ".abc", ".ase", ".aseprite", ".animator", ".npss", ".onnx", ".tflite", ".pt2"])
		);
		expect(assetsAllSupportedExtensions).not.toContain(".json");
	});

	it("keeps every legacy category alias on the shared lists", () => {
		for (const category of [assetsImageExtensions, assetsAudioExtensions, assetsVideoExtensions, assetsModelExtensions, assetsRetainedUIExtensions]) {
			expect(category.every((extension) => assetsAllSupportedExtensions.includes(extension))).toBe(true);
		}
	});
});
